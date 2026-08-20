import { app, ipcMain } from 'electron';
import { log, warn } from 'electron-log/main';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
  createReadStream,
} from 'fs';
import { extname } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { dirname, join } from 'path';
import { IPC } from './shared-with-frontend/ipc-events.const';
import { getIsAppReady, getWin } from './main-window';
import { GlobalConfigState } from '../src/app/features/config/global-config.model';
import {
  LOCAL_REST_API_HOST,
  LOCAL_REST_API_MAX_BODY_BYTES,
  LOCAL_REST_API_MAX_CONCURRENT_REQUESTS,
  LOCAL_REST_API_PORT,
  LOCAL_REST_API_TIMEOUT_MS,
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from './shared-with-frontend/local-rest-api.model';

const JSON_HEADERS = {
  /* eslint-disable-next-line @typescript-eslint/naming-convention */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  'Content-Type': 'application/json; charset=utf-8',
};

let server: Server | null = null;
let isInitialized = false;
let isEnabled = false;
// What the renderer's saved setting asks for, which is not the same thing as
// what the main process managed to do about it: enabling fails closed when the
// token cannot be stored, and the saved setting stays `true` regardless. Kept
// apart so a later recovery can tell "the user wants this on" from "it is on".
let isEnabledDesired = false;
let isListening = false;
let wss: WebSocketServer | null = null;
let localMusicFolderPath: string | null = '/Users/swastik/Music/Study_Mixes';
const activeSockets = new Set<WebSocket>();

const pendingRequests = new Map<
  string,
  {
    resolve: (response: LocalRestApiResponsePayload) => void;
    timeout: NodeJS.Timeout;
  }
>();

// The access token is owned by the main process, not the synced config: it
// authenticates a loopback server that only exists on this one machine, so
// syncing it would leak an authentication secret into the op-log and to every
// other device for no benefit. It is persisted to a 0600 file under userData so
// it survives restarts, and the renderer reads/regenerates it over IPC.
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_LENGTH = 32;
// Largest multiple of the alphabet size that fits in a byte. Bytes at or above
// it are discarded instead of folded in with `%`, which would make the first
// `256 % 62` characters slightly more likely than the rest.
const MAX_UNBIASED_BYTE = Math.floor(256 / TOKEN_ALPHABET.length) * TOKEN_ALPHABET.length;
const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9]{${TOKEN_LENGTH}}$`);

let localRestApiToken: string | undefined = undefined;
let generatedForcedDevToken: string | undefined = undefined;

// Alphanumeric so it survives being copied out of the settings UI and pasted
// into a shell command without quoting.
const generateToken = (): string => {
  let token = '';
  while (token.length < TOKEN_LENGTH) {
    for (const byte of randomBytes(TOKEN_LENGTH)) {
      if (byte >= MAX_UNBIASED_BYTE) {
        continue;
      }
      token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
      if (token.length === TOKEN_LENGTH) {
        break;
      }
    }
  }
  return token;
};

const getTokenFilePath = (): string =>
  join(app.getPath('userData'), 'local-rest-api-token');

/**
 * Restores the 0600 the token file is supposed to have, or reports that it
 * could not. A file that ends up group- or world-readable — restored from a
 * backup, copied with a permissive umask, moved off a filesystem that has no
 * modes — is otherwise served happily for as long as the user never presses
 * Regenerate, which is the one path that used to fix it.
 */
const restrictTokenFileMode = (filePath: string): boolean => {
  // POSIX modes carry no meaning on Windows (`statSync` reports a synthesised
  // 0666/0444 from the read-only flag); access there is governed by the ACL the
  // file inherits from userData.
  if (process.platform === 'win32') {
    return true;
  }
  try {
    if ((statSync(filePath).mode & 0o077) === 0) {
      return true;
    }
    chmodSync(filePath, 0o600);
    // chmod() is allowed to report success without changing anything — a CIFS
    // mount without unix extensions is the documented case — so the one thing
    // worth reading back is the mode it claims to have set. Without this the
    // fail-closed path below never fires on exactly the filesystems that need
    // it, and a world-readable credential is served as if it were locked down.
    if ((statSync(filePath).mode & 0o077) !== 0) {
      warn(
        '[local-rest-api] The access token file is still readable by other accounts ' +
          'after chmod — this filesystem does not enforce POSIX modes',
      );
      return false;
    }
    return true;
  } catch (error) {
    warn('[local-rest-api] Could not restrict the access token file mode', error);
    return false;
  }
};

const loadPersistedToken = (): string | undefined => {
  try {
    const filePath = getTokenFilePath();
    if (!existsSync(filePath)) {
      return undefined;
    }
    const token = readFileSync(filePath, 'utf8').trim();
    // Only accept what generateToken() could have written: a truncated or
    // otherwise corrupted file must not silently become the live credential.
    if (!TOKEN_PATTERN.test(token)) {
      warn(
        '[local-rest-api] Ignoring malformed access token file — generating a new one',
      );
      return undefined;
    }
    // Fail closed if it cannot be locked down: discarding it mints a fresh
    // token into a fresh 0600 file, which costs the user their old token but
    // never keeps serving one that everyone on the machine can read.
    if (!restrictTokenFileMode(filePath)) {
      return undefined;
    }
    return token;
  } catch (error) {
    warn('[local-rest-api] Failed to read access token file', error);
    return undefined;
  }
};

/**
 * Tries to make the *directory entry* created by renameSync() durable. On POSIX the
 * rename is atomic but not crash-safe until the parent directory is fsynced, so
 * without this an abrupt power loss can bring the previous token back after a
 * regeneration that reported success — exactly the guarantee persistToken()
 * exists to make. Best effort by design, and therefore best-effort crash
 * resistance rather than a durability guarantee: the rename already happened
 * and the new token is on disk, so a filesystem that refuses to fsync a
 * directory must not turn a completed write into a failed one — the failure is
 * logged and the rotation still reports success.
 */
const fsyncDirectory = (dirPath: string): void => {
  // Windows has no directory-fsync equivalent — opening a directory for reading
  // fails outright — and NTFS metadata ordering makes the rename durable anyway.
  if (process.platform === 'win32') {
    return;
  }
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dirPath, 'r');
    fsyncSync(dirFd);
  } catch (error) {
    warn('[local-rest-api] Could not fsync the access token directory', error);
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        // Nothing useful left to do with the descriptor.
      }
    }
  }
};

/**
 * Writes the token or throws. Everything up to and including the rename is
 * deliberately not swallowed: the caller must never activate a token that did
 * not reach the disk. The directory fsync that follows the rename is the one
 * exception — the token is already on disk by then, so turning that into a
 * throw would report a failed rotation for a write that actually succeeded,
 * and leave the new token to go live on the next launch while the caller keeps
 * serving the old one. fsyncDirectory() logs instead.
 */
const persistToken = (token: string): void => {
  const filePath = getTokenFilePath();
  // Write a sibling temp file and rename it into place. rename() is atomic, so
  // a crash mid-write cannot leave a half-written token behind.
  //
  // The suffix is random and the open below is exclusive, because the temp path
  // is the weak point of this sequence: a predictable name lets anyone who can
  // create entries in this directory pre-plant a symlink there, and 'w' would
  // follow it — writing the token into a file outside the profile and then
  // renaming the *symlink* into place, so every later read and rotation stays
  // redirected. 'wx' alone would close that, but on a pid-derived name it also
  // refuses to run once a leftover temp from a hard kill is met by a run that
  // draws the same pid, which needs stale-temp handling to undo. A random name
  // has nothing to pre-plant and makes EEXIST unreachable in practice, so the
  // two together need no such recovery. The trade is that a hard kill inside
  // the window orphans a temp file — empty, partial, or the whole 32 bytes,
  // depending on where it lands — that no later run reclaims.
  //
  // What this does not close: renameSync() resolves the name again rather than
  // the open descriptor, so an attacker who renames the temp entry away after
  // the open and leaves a symlink at that path still redirects the result. That
  // needs a won race instead of a file planted at leisure, and it needs the
  // authority to rename an entry this process owns — which a sticky directory
  // denies even when it is world-writable, and which is enough to replace the
  // token file itself where it is not.
  const tmpFilePath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;

  try {
    fd = openSync(tmpFilePath, 'wx', 0o600);
    // `mode` is a request, not a guarantee: a filesystem that does not enforce
    // POSIX modes can create the file group- or world-readable regardless.
    fchmodSync(fd, 0o600);
    // And verify it through the same descriptor rather than trusting the call:
    // fchmod() can succeed without effect on a filesystem that does not enforce
    // POSIX modes. Throwing keeps the write closed, so a token never goes live
    // out of a file other accounts can read.
    if (process.platform !== 'win32') {
      const mode = fstatSync(fd).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `Refusing to store the local REST API access token: the filesystem left ` +
            `it at mode 0${mode.toString(8)} instead of 0600, so other accounts on ` +
            `this machine could read it.`,
        );
      }
    }
    // Only now, once the descriptor is known to be private, does the secret
    // reach the disk. Writing first would put it in a readable file for the
    // length of the check on exactly the filesystems that check exists for.
    writeFileSync(fd, token, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpFilePath, filePath);
    fsyncDirectory(dirname(filePath));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already failing; nothing useful left to do with the descriptor.
      }
    }
    try {
      unlinkSync(tmpFilePath);
    } catch {
      // Best effort: there may be nothing to clean up.
    }
    throw error;
  }
};

/** Returns the active token, generating and persisting one if none exists yet. */
const ensureToken = (): string => {
  if (!localRestApiToken) {
    localRestApiToken = loadPersistedToken();
  }
  if (!localRestApiToken) {
    const token = generateToken();
    persistToken(token);
    localRestApiToken = token;
  }
  return localRestApiToken;
};

const regenerateToken = (): string => {
  // Persist before swapping. Regeneration is the revocation path — the user
  // reaches for it precisely when they think the token leaked — so the new
  // token only goes live once the write has landed on disk. Swapping first would let a
  // failed write leave the *old* token on disk and bring it back to life on the
  // next launch, silently breaking the immediate-revocation guarantee.
  const token = generateToken();
  persistToken(token);
  localRestApiToken = token;
  return token;
};

const compareToken = (input: string, expected: string): boolean => {
  const inputBuffer = Buffer.from(input, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (inputBuffer.length !== expectedBuffer.length) {
    // Perform a dummy comparison with expectedBuffer to mitigate timing attacks on length differences
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }

  return timingSafeEqual(inputBuffer, expectedBuffer);
};

const writeJson = (
  res: ServerResponse,
  status: number,
  body: LocalRestApiResponsePayload['body'],
  extraHeaders: Record<string, string> = {},
): void => {
  const responseJson = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    // eslint-disable-next-line @typescript-eslint/naming-convention
    'Content-Length': Buffer.byteLength(responseJson),
    ...extraHeaders,
  });
  res.end(responseJson);
};

// RFC 7235 requires a challenge on every 401. It also tells the scripts written
// against the unauthenticated API (v18.1.0 onwards) what to do, since this 401
// is the only thing they will see after upgrading.
const UNAUTHORIZED_HEADERS = {
  /* eslint-disable-next-line @typescript-eslint/naming-convention */
  'WWW-Authenticate': 'Bearer',
};
const TOKEN_LOCATION_HINT = 'Find the token in Settings → Misc → Access Token.';

const respondUnauthorized = (res: ServerResponse, message: string): void => {
  writeJson(
    res,
    401,
    {
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message,
      },
    },
    UNAUTHORIZED_HEADERS,
  );
};

const isCurrentToken = (candidate: string): boolean =>
  !!localRestApiToken && compareToken(candidate, localRestApiToken);

const BEARER_SCHEME = 'bearer';

/**
 * Pulls the credential out of an `Authorization: Bearer <token>` header, or
 * returns undefined if the header is not a bearer credential.
 *
 * Scanned by hand rather than matched with `/^Bearer +(.+)$/i`, which CodeQL
 * flags as polynomial: the space run and the credential can both match a space,
 * so an input that fails the anchor after the spaces is retried at every split
 * of them. The reachable inputs are not that input — the retry needs a suffix
 * that fails `$`, and no character `.` rejects can reach the handler: Node
 * answers 400 for `\n` and `\r`, and it decodes header values as latin1, which
 * cannot produce a code point above U+00FF, so U+2028 and U+2029 never arrive.
 * So no live DoS is being closed here; a single left-to-right pass simply costs
 * the same on every input and removes the question. Behaviour is unchanged —
 * RFC 7235 auth schemes are case-insensitive, so "bearer <token>" is accepted
 * too, at least one space must separate scheme from credential, and the
 * credential is the rest of the header verbatim.
 */
const parseBearerToken = (authHeader: string | undefined): string | undefined => {
  if (
    !authHeader ||
    authHeader.length <= BEARER_SCHEME.length ||
    authHeader.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME
  ) {
    return undefined;
  }
  let tokenStart = BEARER_SCHEME.length;
  while (tokenStart < authHeader.length && authHeader[tokenStart] === ' ') {
    tokenStart++;
  }
  // No separating space, or nothing after it.
  if (tokenStart === BEARER_SCHEME.length || tokenStart === authHeader.length) {
    return undefined;
  }
  return authHeader.slice(tokenStart);
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bufferChunk.length;
    if (totalBytes > LOCAL_REST_API_MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(bufferChunk);
  }

  if (!chunks.length) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const getQueryObject = (url: URL): Record<string, string | string[]> => {
  const query: Record<string, string | string[]> = {};

  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length <= 1 ? (values[0] ?? '') : values;
  }

  return query;
};

const forwardRequestToRenderer = async (
  payload: LocalRestApiRequestPayload,
): Promise<LocalRestApiResponsePayload> => {
  const mainWindow = getWin();

  return new Promise<LocalRestApiResponsePayload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(payload.requestId);
      reject(new Error('Renderer request timed out'));
    }, LOCAL_REST_API_TIMEOUT_MS);

    pendingRequests.set(payload.requestId, {
      resolve,
      timeout,
    });

    mainWindow.webContents.send(IPC.LOCAL_REST_API_REQUEST, payload);
  });
};

const handleResponse = (_event: unknown, payload: LocalRestApiResponsePayload): void => {
  const pending = pendingRequests.get(payload.requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeout);
  pendingRequests.delete(payload.requestId);
  pending.resolve(payload);
};

const ALLOWED_HOSTS = new Set([
  `${LOCAL_REST_API_HOST}:${LOCAL_REST_API_PORT}`,
  `localhost:${LOCAL_REST_API_PORT}`,
  LOCAL_REST_API_HOST,
  'localhost',
]);

const isForceEnabledForDev = (): boolean =>
  process.env.NODE_ENV === 'DEV' && process.env.SP_FORCE_LOCAL_REST_API === '1';

const getForcedDevToken = (): string => {
  if (process.env.SP_FORCE_LOCAL_REST_API_TOKEN) {
    return process.env.SP_FORCE_LOCAL_REST_API_TOKEN;
  }

  if (!generatedForcedDevToken) {
    generatedForcedDevToken = generateToken();
    // Printed to stdout, never electron-log: the app has a user-visible log
    // export and the house rule is to never write secrets into it.
    console.log(
      '[local-rest-api] Generated temporary access token for SP_FORCE_LOCAL_REST_API=1: ' +
        generatedForcedDevToken +
        '\n[local-rest-api] Set SP_FORCE_LOCAL_REST_API_TOKEN to choose it explicitly.',
    );
  }

  return generatedForcedDevToken;
};

const serveOverlayStaticFile = (pathname: string, res: ServerResponse): void => {
  // Strip '/overlay' prefix, default to /index.html
  let filePath = pathname.replace(/^\/overlay/, '');
  if (filePath === '' || filePath === '/') {
    filePath = '/index.html';
  }

  // Prevent directory traversal attacks
  const safeSuffix = filePath.replace(/^(\.\.[\/\\])+/, '');
  const finalPath = join(__dirname, 'overlay-dist', safeSuffix);

  if (!existsSync(finalPath)) {
    // SPA fallback: return index.html for unknown routes under /overlay
    const indexPath = join(__dirname, 'overlay-dist', 'index.html');
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath);
      // eslint-disable-next-line @typescript-eslint/naming-convention
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/naming-convention
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    const content = readFileSync(finalPath);
    let contentType = 'text/plain';
    const ext = extname(finalPath).toLowerCase();
    switch (ext) {
      case '.html':
        contentType = 'text/html; charset=utf-8';
        break;
      case '.js':
        contentType = 'application/javascript; charset=utf-8';
        break;
      case '.css':
        contentType = 'text/css; charset=utf-8';
        break;
      case '.json':
        contentType = 'application/json; charset=utf-8';
        break;
      case '.png':
        contentType = 'image/png';
        break;
      case '.jpg':
      case '.jpeg':
        contentType = 'image/jpeg';
        break;
      case '.gif':
        contentType = 'image/gif';
        break;
      case '.svg':
        contentType = 'image/svg+xml';
        break;
      case '.ico':
        contentType = 'image/x-icon';
        break;
      case '.mp3':
        contentType = 'audio/mpeg';
        break;
    }
    // eslint-disable-next-line @typescript-eslint/naming-convention
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
};

const handleHttpRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  // Reject everything while disabled. server.close() stops accepting new
  // sockets, but an in-flight keep-alive connection could still be served
  // during the close window; this makes the off switch immediate.
  if (!isEnabled) {
    writeJson(res, 503, {
      ok: false,
      error: {
        code: 'API_DISABLED',
        message: 'Local REST API is disabled',
      },
    });
    return;
  }

  // Intercept requests for the overlay UI
  const requestUrl = new URL(req.url ?? '/', `http://${LOCAL_REST_API_HOST}`);
  if (requestUrl.pathname.startsWith('/overlay')) {
    serveOverlayStaticFile(requestUrl.pathname, res);
    return;
  }

  // Handle local music player API
  if (requestUrl.pathname === '/music/list') {
    console.log(
      '[local-rest-api-music] GET /music/list requested. localMusicFolderPath:',
      localMusicFolderPath,
    );
    if (!localMusicFolderPath) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'No music folder configured' }));
      return;
    }
    try {
      const files = readdirSync(localMusicFolderPath).filter((file) => {
        const ext = extname(file).toLowerCase();
        return ['.mp3', '.wav', '.ogg'].includes(ext);
      });
      console.log(
        `[local-rest-api-music] GET /music/list found ${files.length} valid audio files.`,
      );
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true, files }));
    } catch (e) {
      console.error('[local-rest-api-music] GET /music/list Error reading directory:', e);
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Failed to read directory' }));
    }
    return;
  }

  if (requestUrl.pathname === '/music/metadata') {
    const fileName = requestUrl.searchParams.get('file');
    if (!fileName || !localMusicFolderPath) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Bad Request' }));
      return;
    }
    const safeName = fileName.replace(/^[\.\/]+/, '');
    const fullPath = join(localMusicFolderPath, safeName);

    let output = '';
    const ffprobe = spawn('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_chapters',
      '-show_format',
      fullPath,
    ]);

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: 'ffprobe failed' }));
        return;
      }
      try {
        const parsed = JSON.parse(output);
        const title = parsed.format?.tags?.title || fileName;
        const chapters =
          parsed.chapters?.map((ch: any) => ({
            start: parseFloat(ch.start_time),
            end: parseFloat(ch.end_time),
            title: ch.tags?.title || 'Unknown',
          })) || [];

        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, title, chapters }));
      } catch (e) {
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: 'Parse failed' }));
      }
    });

    ffprobe.on('error', () => {
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'ffprobe not found' }));
    });
    return;
  }

  if (requestUrl.pathname === '/music/art') {
    const fileName = requestUrl.searchParams.get('file');
    if (!fileName || !localMusicFolderPath) {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    const safeName = fileName.replace(/^[\.\/]+/, '');
    const fullPath = join(localMusicFolderPath, safeName);

    res.writeHead(200, {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Content-Type': 'image/jpeg',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Cache-Control': 'public, max-age=86400',
    });

    const ffmpeg = spawn('ffmpeg', [
      '-i',
      fullPath,
      '-an',
      '-vcodec',
      'copy',
      '-f',
      'image2pipe',
      '-',
    ]);

    ffmpeg.stdout.pipe(res);

    ffmpeg.on('error', () => {
      // If error, just end response cleanly
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
    return;
  }

  if (requestUrl.pathname === '/music/stream') {
    const fileName = requestUrl.searchParams.get('file');
    if (!fileName || !localMusicFolderPath) {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    const safeName = fileName.replace(/^[\.\/]+/, '');
    const fullPath = join(localMusicFolderPath, safeName);

    try {
      const stat = statSync(fullPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = end - start + 1;
        const file = createReadStream(fullPath, { start, end });
        const head = {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'Accept-Ranges': 'bytes',
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'Content-Length': chunksize,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'Content-Type': 'audio/mpeg',
        };
        res.writeHead(206, head);
        file.pipe(res);
      } else {
        const head = {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'Content-Length': fileSize,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'Content-Type': 'audio/mpeg',
        };
        res.writeHead(200, head);
        createReadStream(fullPath).pipe(res);
      }
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Failed to stream file');
    }
    return;
  }

  if (requestUrl.pathname === '/music/command' && req.method === 'POST') {
    let body: any;
    try {
      body = await readJsonBody(req);
      console.log('[local-rest-api-music] POST /music/command received:', body);
    } catch (e) {
      console.error(
        '[local-rest-api-music] POST /music/command Error parsing JSON body:',
        e,
      );
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Invalid body' }));
      return;
    }

    if (wss) {
      const msg = JSON.stringify({
        type: 'MUSIC_COMMAND',
        action: body.action,
        value: body.value,
      });
      console.log(
        `[local-rest-api-music] Broadcasting to ${wss.clients.size} WebSocket clients:`,
        msg,
      );
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      });
    } else {
      console.warn(
        '[local-rest-api-music] Warning: Received command but WebSocket server is NOT running!',
      );
    }

    res.writeHead(200, {
      ...JSON_HEADERS,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Access-Control-Allow-Origin': '*',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Handle OPTIONS for CORS preflight
  if (requestUrl.pathname === '/music/command' && req.method === 'OPTIONS') {
    res.writeHead(204, {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Access-Control-Allow-Origin': '*',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Block DNS rebinding: reject requests with unexpected Host headers
  const host = req.headers.host;
  if (!host || !ALLOWED_HOSTS.has(host)) {
    writeJson(res, 403, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Invalid Host header',
      },
    });
    return;
  }

  // Block browser-CSRF: reject any request that arrives with a web Origin.
  // The intended consumers are CLI tools and scripts (no Origin header).
  // Browsers always set Origin on cross-origin POSTs (and on simple POSTs
  // with text/plain bodies, which CORS does not preflight); rejecting here
  // closes that gap on top of the Host-header check above.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    writeJson(res, 403, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Requests from web origins are not allowed',
      },
    });
    return;
  }

  if (pendingRequests.size >= LOCAL_REST_API_MAX_CONCURRENT_REQUESTS) {
    writeJson(res, 429, {
      ok: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: `Too many concurrent requests (limit: ${LOCAL_REST_API_MAX_CONCURRENT_REQUESTS})`,
      },
    });
    return;
  }

  const method = req.method ?? 'GET';

  if (method === 'GET' && requestUrl.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      data: {
        server: 'up',
        rendererReady: getIsAppReady(),
      },
    });
    return;
  }

  // Validate authorization token. The token is sent in the "Authorization"
  // header as "Bearer <token>".
  const tokenToValidate = parseBearerToken(req.headers.authorization);
  if (tokenToValidate === undefined) {
    respondUnauthorized(
      res,
      `Authorization token required — send "Authorization: Bearer <token>". ${TOKEN_LOCATION_HINT}`,
    );
    return;
  }

  if (!isCurrentToken(tokenToValidate)) {
    respondUnauthorized(res, `Invalid authorization token. ${TOKEN_LOCATION_HINT}`);
    return;
  }

  if (!getIsAppReady()) {
    writeJson(res, 503, {
      ok: false,
      error: {
        code: 'APP_NOT_READY',
        message: 'Renderer is not ready yet',
      },
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, {
      ok: false,
      error: {
        code: 'INVALID_REQUEST_BODY',
        message: error instanceof Error ? error.message : 'Invalid request body',
      },
    });
    return;
  }

  // Check again, now that the body is in. The token was only validated against
  // the headers, and a body can take arbitrarily long to arrive — Node's
  // request timeout here is 300s, and the renderer's own 15s budget only starts
  // once the request is forwarded. Without this, whoever holds a leaked token
  // can bank mutating requests: open them, wait out the rotation, then let the
  // bodies land. "Regenerating invalidates the previous token immediately" has
  // to hold for a request that was authenticated but not yet executed.
  if (!isCurrentToken(tokenToValidate)) {
    respondUnauthorized(res, `Invalid authorization token. ${TOKEN_LOCATION_HINT}`);
    return;
  }

  try {
    const rendererResponse = await forwardRequestToRenderer({
      requestId: randomUUID(),
      method,
      path: requestUrl.pathname,
      query: getQueryObject(requestUrl),
      body,
    });
    writeJson(res, rendererResponse.status, rendererResponse.body);
  } catch (error) {
    warn('[local-rest-api] Request failed', requestUrl.pathname, error);
    const isTimeout =
      error instanceof Error && error.message === 'Renderer request timed out';
    writeJson(res, isTimeout ? 504 : 500, {
      ok: false,
      error: {
        code: isTimeout ? 'RENDERER_TIMEOUT' : 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown internal error',
      },
    });
  }
};

export const initLocalRestApi = (): void => {
  if (isInitialized) {
    return;
  }
  isInitialized = true;

  ipcMain.on(IPC.LOCAL_REST_API_RESPONSE, handleResponse);
  ipcMain.on(IPC.LOCAL_REST_API_BROADCAST_STATE, (_event, state) => {
    if (!wss) return;
    const msg = JSON.stringify(state);
    for (const client of activeSockets) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  });

  // The renderer reads and regenerates the token over IPC; it is never stored
  // in the synced config. Both handlers throw when the token cannot be stored,
  // and only reconcile once it could — see startServerIfDesired().
  ipcMain.handle(IPC.LOCAL_REST_API_GET_TOKEN, () => {
    if (isForceEnabledForDev()) {
      return getForcedDevToken();
    }
    const token = ensureToken();
    startServerIfDesired();
    return token;
  });
  // In forced-dev mode the getter serves the forced token, so regenerating a
  // real one would activate a credential the getter never returns — and would
  // overwrite the user's actual persisted token file. Keep it a no-op.
  ipcMain.handle(IPC.LOCAL_REST_API_REGENERATE_TOKEN, () => {
    if (isForceEnabledForDev()) {
      return getForcedDevToken();
    }
    const token = regenerateToken();
    startServerIfDesired();
    return token;
  });

  server = createServer((req, res) => {
    void handleHttpRequest(req, res);
  });

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${LOCAL_REST_API_HOST}`);

    if (url.pathname === '/music/ws') {
      wss?.handleUpgrade(request, socket, head, (ws) => {
        console.log('[local-rest-api-music] New WebSocket client connected!');
        activeSockets.add(ws);
        ws.on('close', () => {
          console.log('[local-rest-api-music] WebSocket client disconnected!');
          activeSockets.delete(ws);
        });

        ws.on('message', (message) => {
          try {
            const parsed = JSON.parse(message.toString());
            // Broadcast to ALL OTHER clients (except the one that sent it)
            for (const client of activeSockets) {
              if (client !== ws && client.readyState === 1 /* OPEN */) {
                client.send(message.toString());
              }
            }
          } catch (e) {
            console.error('[local-rest-api-music] Failed to parse message', e);
          }
        });

        // Ping clients occasionally to keep connections alive
        ws.on('pong', () => {
          (ws as any).isAlive = true;
        });
        wss?.emit('connection', ws, request);
      });
      return;
    }

    // Existing /ws path for extension bridge
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const tokenToValidate = url.searchParams.get('token');
    if (!tokenToValidate || !isCurrentToken(tokenToValidate)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss?.handleUpgrade(request, socket, head, (ws) => {
      console.log('[local-rest-api] New bridge WebSocket client connected!');
      activeSockets.add(ws);
      ws.on('close', () => {
        console.log('[local-rest-api] Bridge WebSocket client disconnected!');
        activeSockets.delete(ws);
      });
      // Ping clients occasionally to keep connections alive
      ws.on('pong', () => {
        (ws as any).isAlive = true;
      });
      wss?.emit('connection', ws, request);
    });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    isListening = false;
    if (error.code === 'EADDRINUSE') {
      warn(
        `[local-rest-api] Port ${LOCAL_REST_API_PORT} is in use — API could not start. ` +
          `Another process is holding it; free it and toggle the API off/on to retry.`,
      );
      return;
    }
    warn('[local-rest-api] Server error', error);
  });

  if (isForceEnabledForDev()) {
    warn('[local-rest-api] Enabled by SP_FORCE_LOCAL_REST_API=1 for DEV runtime');
    localRestApiToken = getForcedDevToken();
    isEnabled = true;
    startServer();
  }
};

const startServer = (): void => {
  if (!server || isListening) {
    return;
  }

  server.listen(LOCAL_REST_API_PORT, LOCAL_REST_API_HOST, () => {
    isListening = true;
    log(
      `[local-rest-api] Listening on http://${LOCAL_REST_API_HOST}:${LOCAL_REST_API_PORT}`,
    );
  });
};

/**
 * Brings the API up if the saved setting wants it and only a storage failure
 * stopped it. Both token IPCs call this because they are the point at which the
 * main process learns that storage works again — otherwise the setting reads
 * "enabled" while nothing listens, and stays that way until the next settings
 * change or restart. It cannot switch the API on by itself: `isEnabledDesired`
 * only ever comes from the saved setting.
 */
const startServerIfDesired = (): void => {
  if (!isEnabledDesired || isEnabled) {
    return;
  }
  log('[local-rest-api] Access token is available again — starting the server');
  isEnabled = true;
  startServer();
};

const stopServer = (): void => {
  if (!server || !isListening) {
    return;
  }

  // Reset eagerly: server.close() only invokes its callback once every socket
  // has closed, so a lingering keep-alive connection would otherwise leave
  // isListening=true forever and make a later re-enable a no-op (#7484).
  isListening = false;

  server.close((error) => {
    if (error) {
      warn('[local-rest-api] Failed to stop server', error);
      return;
    }

    log('[local-rest-api] Server stopped');
  });

  // Force keep-alive sockets shut so the API stops serving immediately on
  // disable and close() can actually complete.
  server.closeAllConnections();
};

export const updateLocalRestApiConfig = (cfg: GlobalConfigState): void => {
  localMusicFolderPath = cfg.misc.localMusicFolderPath || '/Users/swastik/Music/Study_Mixes';
  const isForcedForDev = isForceEnabledForDev();
  const nextEnabled = isForcedForDev || !!cfg.misc.isLocalRestApiEnabled;
  isEnabledDesired = nextEnabled;
  // Ensure a token exists whenever the server is (about to be) serving, so
  // enabling the API never starts an unreachable server with no credential.
  if (nextEnabled) {
    try {
      localRestApiToken = isForcedForDev ? getForcedDevToken() : ensureToken();
    } catch (error) {
      // Without a durably stored token the credential would die on the next
      // launch, so fail closed rather than start a server the user cannot keep
      // using. The renderer surfaces the failure when it reads the token.
      warn('[local-rest-api] Could not store the access token — not starting', error);
      isEnabled = false;
      stopServer();
      return;
    }
  }
  if (nextEnabled === isEnabled) {
    if (nextEnabled && !isListening) {
      startServer();
    } else if (!nextEnabled && isListening) {
      stopServer();
    }
    return;
  }

  isEnabled = nextEnabled;
  if (isEnabled) {
    startServer();
  } else {
    stopServer();
  }
};
