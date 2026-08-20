import { Injectable, signal, computed, OnDestroy, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { IS_ELECTRON } from '../../app.constants';
import {
  LOCAL_REST_API_HOST,
  LOCAL_REST_API_PORT,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';

export interface ChapterInfo {
  start: number;
  end: number;
  title: string;
}

export interface TrackMetadata {
  title?: string;
  artist?: string;
  chapters?: ChapterInfo[];
}

@Injectable({
  providedIn: 'root',
})
export class MusicEngineService implements OnDestroy {
  private readonly _http = inject(HttpClient);

  // Audio elements & Web Audio API
  private _audio: HTMLAudioElement;
  private _audioCtx: AudioContext | null = null;
  private _analyser: AnalyserNode | null = null;
  private _gainNode: GainNode | null = null;
  private _source: MediaElementAudioSourceNode | null = null;
  private _animTimerId: ReturnType<typeof setTimeout> | undefined;
  private _lastVisBroadcast = 0;
  private _lastTimeBroadcast = 0;

  // State Signals
  readonly isPlaying = signal<boolean>(false);
  readonly volume = signal<number>(1);
  readonly currentTrack = signal<string>('');
  readonly currentChapter = signal<string>('');
  readonly metadata = signal<TrackMetadata | null>(null);

  readonly currentTime = signal<number>(0);
  readonly duration = signal<number>(0);
  readonly visualizerData = signal<number[]>(new Array(16).fill(0));
  readonly bassIntensity = signal<number>(0);

  readonly trackList = signal<string[]>([]);
  readonly currentIndex = signal<number>(0);
  readonly shuffleMode = signal<boolean>(false);
  readonly errorMsg = signal<string>('');

  readonly trackDisplayName = computed(() => {
    const chapter = this.currentChapter();
    const meta = this.metadata();
    const track = this.currentTrack();

    if (!track) return 'No Music Playing';

    let title = track.replace(/\.(mp3|wav|ogg)$/i, '').replace(/[-_]/g, ' ');
    if (meta?.title) title = meta.title;

    if (chapter) return `${chapter} - ${title}`;
    return title;
  });

  readonly trackArtistName = computed(() => {
    const meta = this.metadata();
    return meta?.artist ? meta.artist : 'Local Player';
  });

  private get _baseUrl(): string {
    return `http://${LOCAL_REST_API_HOST}:${LOCAL_REST_API_PORT}`;
  }

  private _ws: WebSocket | null = null;
  private _reconnectTimeout: any;

  constructor() {
    this._audio = new Audio();
    this._audio.preload = 'auto';

    this._audio.addEventListener('timeupdate', () => this._onTimeUpdate());
    this._audio.addEventListener('loadedmetadata', () => this._onLoadedMetadata());
    this._audio.addEventListener('ended', () => this.next());
    this._audio.addEventListener('play', () => this._initAudioContext());

    this.fetchTrackList();
    this._connectWs();
  }

  ngOnDestroy(): void {
    if (this._animTimerId) {
      clearTimeout(this._animTimerId);
    }
    if (this._ws) {
      this._ws.close();
    }
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
    }
    this._audio.pause();
    this._audio.src = '';
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      void this._audioCtx.close();
    }
  }

  private _connectWs(): void {
    try {
      this._ws = new WebSocket(
        `ws://${LOCAL_REST_API_HOST}:${LOCAL_REST_API_PORT}/music/ws`,
      );

      this._ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'MUSIC_COMMAND') {
            this._handleCommand(msg);
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[MusicEngineService] Failed to parse WebSocket message', e);
        }
      };

      this._ws.onclose = () => {
        this._reconnectTimeout = setTimeout(() => this._connectWs(), 3000);
      };

      this._ws.onerror = (e) => {
        // eslint-disable-next-line no-console
        console.error('[MusicEngineService] WS Error', e);
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MusicEngineService] Failed to create WebSocket', e);
      this._reconnectTimeout = setTimeout(() => this._connectWs(), 3000);
    }
  }

  private _handleCommand(msg: {
    action: string;
    value?: unknown;
    fadeMs?: number;
  }): void {
    switch (msg.action) {
      case 'play_pause':
        this.togglePlay();
        break;
      case 'next':
        this.next();
        break;
      case 'prev':
        this.prev();
        break;
      case 'seek_time':
        if (typeof msg.value === 'number') {
          this.seek(msg.value);
        }
        break;
      case 'set_track':
        if (typeof msg.value === 'string') {
          this.playTrackByName(msg.value);
        }
        break;
      case 'set_shuffle':
        this.setShuffle(!!msg.value);
        break;
      case 'set_music_folder':
        this.fetchTrackList();
        break;
      case 'set_vol': {
        const val =
          typeof msg.value === 'number' ? msg.value : parseFloat(msg.value as string);
        if (!isNaN(val)) {
          this.setVolume(val, msg.fadeMs);
        }
        break;
      }
    }
  }

  fetchTrackList(): void {
    this._http
      .get<{ ok: boolean; files?: string[] }>(`${this._baseUrl}/music/list`)
      .subscribe({
        next: (res) => {
          if (res.ok && res.files && res.files.length > 0) {
            const sorted = [...res.files].sort();
            this.trackList.set(sorted);
            if (!this.currentTrack()) {
              this.currentTrack.set(sorted[0]);
              this._audio.src = `${this._baseUrl}/music/stream?file=${encodeURIComponent(sorted[0])}`;
              this._loadMetadata(sorted[0]);
            }
          } else {
            this.trackList.set([]);
          }
        },
        error: (err) => {
          // eslint-disable-next-line no-console
          console.warn('[MusicEngineService] Failed to fetch track list:', err);
        },
      });
  }

  private _loadMetadata(trackFilename: string): void {
    if (!trackFilename) return;
    this.metadata.set(null);
    this.currentChapter.set('');

    this._http
      .get<{
        ok: boolean;
        title?: string;
        chapters?: ChapterInfo[];
      }>(`${this._baseUrl}/music/metadata?file=${encodeURIComponent(trackFilename)}`)
      .subscribe({
        next: (data) => {
          if (data.ok) {
            const meta: TrackMetadata = {
              title: data.title,
              chapters: data.chapters,
            };
            this.metadata.set(meta);
            this._broadcastState();
          }
        },
        error: (err) => {
          // eslint-disable-next-line no-console
          console.warn('[MusicEngineService] Failed to fetch metadata:', err);
        },
      });
  }

  // --- Web Audio API Initialization & Render Loop ---

  private _initAudioContext(): void {
    if (this._audioCtx) {
      if (this._audioCtx.state === 'suspended') {
        void this._audioCtx.resume();
      }
      return;
    }

    try {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this._audioCtx = new AudioContextClass();

      const analyser = this._audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      this._analyser = analyser;

      const source = this._audioCtx.createMediaElementSource(this._audio);
      this._source = source;

      const gainNode = this._audioCtx.createGain();
      gainNode.gain.value = this.volume();
      this._gainNode = gainNode;

      source.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(this._audioCtx.destination);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MusicEngineService] Failed to init Web Audio API:', e);
    }
  }

  private _startVisualizerLoop(): void {
    if (this._animTimerId) {
      clearTimeout(this._animTimerId);
    }

    const render = (): void => {
      if (!this.isPlaying()) {
        this.visualizerData.set(new Array(16).fill(0));
        this.bassIntensity.set(0);
        this._broadcastVisualizer(new Array(16).fill(0), false);
        return;
      }

      this._animTimerId = setTimeout(render, 100);

      if (!this._analyser) return;

      const dataArray = new Uint8Array(this._analyser.frequencyBinCount);
      this._analyser.getByteFrequencyData(dataArray);

      // Bass Intensity
      let bassSum = 0;
      for (let i = 0; i < 5; i++) {
        bassSum += dataArray[i];
      }
      const bassAvg = bassSum / 5;
      const normalizedBass = Math.pow(bassAvg / 255, 3) * 1.5;
      this.bassIntensity.set(normalizedBass);

      const now = Date.now();
      if (now - this._lastVisBroadcast > 66) {
        // 16 Bins
        const bins = 16;
        const binSize = Math.floor(this._analyser.frequencyBinCount / bins);
        const visualizerData: number[] = [];
        for (let i = 0; i < bins; i++) {
          let sum = 0;
          const offset = i * binSize;
          for (let j = 0; j < binSize; j++) {
            sum += dataArray[offset + j];
          }
          visualizerData.push(Math.round(sum / binSize));
        }

        this.visualizerData.set(visualizerData);
        this._broadcastVisualizer(visualizerData, true);
        this._lastVisBroadcast = now;
      }
    };

    render();
  }

  // --- Audio Event Handlers ---

  private _onTimeUpdate(): void {
    const time = this._audio.currentTime || 0;
    const dur = this._audio.duration || 0;

    this.currentTime.set(time);
    this.duration.set(dur);

    // Chapter updating
    const meta = this.metadata();
    if (meta?.chapters && meta.chapters.length > 0) {
      const ch = meta.chapters.find((c) => time >= c.start && time < c.end);
      const newTitle = ch ? ch.title : '';
      if (newTitle !== this.currentChapter()) {
        this.currentChapter.set(newTitle);
        this._broadcastState();
      }
    }

    const now = Date.now();
    if (now - this._lastTimeBroadcast > 1000) {
      this._broadcastTime(time, dur);
      this._lastTimeBroadcast = now;
    }
  }

  private _onLoadedMetadata(): void {
    const time = this._audio.currentTime || 0;
    const dur = this._audio.duration || 0;
    this.currentTime.set(time);
    this.duration.set(dur);
    this._broadcastTime(time, dur);
  }

  // --- Playback Commands ---

  togglePlay(): void {
    if (this.isPlaying()) {
      this.pause();
    } else {
      void this.play();
    }
  }

  async play(): Promise<void> {
    try {
      this._initAudioContext();
      if (this._audioCtx && this._audioCtx.state === 'suspended') {
        await this._audioCtx.resume();
      }
      await this._audio.play();
      this.isPlaying.set(true);
      this.errorMsg.set('');
      this._startVisualizerLoop();
      this._broadcastState();
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[MusicEngineService] Play error:', err);
      this.errorMsg.set(err?.message || 'Playback blocked');
    }
  }

  pause(): void {
    this._audio.pause();
    this.isPlaying.set(false);
    if (this._audioCtx && this._audioCtx.state === 'running') {
      void this._audioCtx.suspend();
    }
    this.visualizerData.set(new Array(16).fill(0));
    this.bassIntensity.set(0);
    this._broadcastState();
    this._broadcastVisualizer(new Array(16).fill(0), false);
  }

  playTrackIndex(index: number): void {
    const list = this.trackList();
    if (list.length === 0 || index < 0 || index >= list.length) return;

    this.currentIndex.set(index);
    const track = list[index];
    this.currentTrack.set(track);
    this._audio.src = `${this._baseUrl}/music/stream?file=${encodeURIComponent(track)}`;
    this._loadMetadata(track);
    void this.play();
  }

  playTrackByName(trackName: string): void {
    const list = this.trackList();
    const idx = list.findIndex((t) => t === trackName || t.includes(trackName));
    if (idx !== -1) {
      this.playTrackIndex(idx);
    }
  }

  next(): void {
    const list = this.trackList();
    if (list.length === 0) return;

    if (this.shuffleMode() && list.length > 1) {
      let nextIdx = this.currentIndex();
      while (nextIdx === this.currentIndex()) {
        nextIdx = Math.floor(Math.random() * list.length);
      }
      this.playTrackIndex(nextIdx);
    } else {
      const nextIdx = (this.currentIndex() + 1) % list.length;
      this.playTrackIndex(nextIdx);
    }
  }

  prev(): void {
    const list = this.trackList();
    if (list.length === 0) return;

    const prevIdx = (this.currentIndex() - 1 + list.length) % list.length;
    this.playTrackIndex(prevIdx);
  }

  seek(seconds: number): void {
    if (this._audio) {
      this._audio.currentTime = seconds;
      this.currentTime.set(seconds);
      this._broadcastTime(seconds, this.duration());
    }
  }

  skipForward(seconds = 10): void {
    this.seek(this.currentTime() + seconds);
  }

  skipBackward(seconds = 10): void {
    this.seek(Math.max(0, this.currentTime() - seconds));
  }

  setVolume(vol: number, fadeMs = 0): void {
    const clamped = Math.max(0, Math.min(1, vol));
    this.volume.set(clamped);

    if (this._gainNode && this._audioCtx) {
      const now = this._audioCtx.currentTime;
      if (fadeMs > 0) {
        const fadeSec = fadeMs / 1000;
        this._gainNode.gain.linearRampToValueAtTime(clamped, now + fadeSec);
      } else {
        this._gainNode.gain.value = clamped;
      }
    }
    this._audio.volume = clamped;
    this._broadcastState();
  }

  setShuffle(enabled: boolean): void {
    this.shuffleMode.set(enabled);
  }

  // --- Electron IPC Broadcasting ---

  private _broadcastState(): void {
    if (!IS_ELECTRON || !window.ea?.broadcastLocalRestApiState) return;

    window.ea.broadcastLocalRestApiState({
      type: 'MUSIC_STATE',
      isPlaying: this.isPlaying(),
      volume: this.volume(),
      currentTrack: this.currentTrack(),
      currentChapter: this.currentChapter(),
      metadata: this.metadata(),
    });
  }

  private _broadcastTime(time: number, dur: number): void {
    if (!IS_ELECTRON || !window.ea?.broadcastLocalRestApiState) return;

    window.ea.broadcastLocalRestApiState({
      type: 'MUSIC_TIME',
      currentTime: time,
      duration: dur,
    });
  }

  private _broadcastVisualizer(data: number[], playing: boolean): void {
    if (!IS_ELECTRON || !window.ea?.broadcastLocalRestApiState) return;

    window.ea.broadcastLocalRestApiState({
      type: 'MUSIC_VISUALIZER',
      data,
      isPlaying: playing,
    });
  }
}
