import { Injectable, signal, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngrx/store';
import {
  LOCAL_REST_API_PORT,
  LOCAL_REST_API_HOST,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';
import { selectCurrentScreen } from './store/focus-mode.selectors';
import { selectFocusModeConfig } from '../config/store/global-config.reducer';
import { FocusScreen } from './focus-mode.model';
import { combineLatest } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

export interface MusicState {
  isPlaying: boolean;
  volume: number;
  currentTrack: string;
  currentChapter: string;
  metadata: any;
}

@Injectable({
  providedIn: 'root',
})
export class MusicControlService {
  private _store = inject(Store);

  private _ws: WebSocket | null = null;
  private _reconnectTimeout: any;

  readonly isPlaying = signal<boolean>(false);
  readonly volume = signal<number>(1);
  readonly currentTrack = signal<string>('');
  readonly currentChapter = signal<string>('');
  readonly metadata = signal<any>(null);

  readonly currentTime = signal<number>(0);
  readonly duration = signal<number>(0);
  readonly visualizerData = signal<number[]>(new Array(16).fill(0));

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

  constructor() {
    this._connectWs();

    // Volume Orchestration based on Mode
    combineLatest([
      this._store.select(selectCurrentScreen).pipe(distinctUntilChanged()),
      this._store.select(selectFocusModeConfig),
    ])
      .pipe(takeUntilDestroyed())
      .subscribe(([screen, config]) => {
        let targetVol = 0.5; // default fallback
        if (screen === FocusScreen.Main) {
          targetVol = config.musicVolumeFocus ?? 0.6;
        } else if (screen === FocusScreen.Break) {
          targetVol = config.musicVolumeBreak ?? 0.8;
        } else if (
          screen === FocusScreen.WaitingForNextFocus ||
          screen === FocusScreen.TaskSelection ||
          screen === FocusScreen.Preparation
        ) {
          targetVol = config.musicVolumeIdle ?? 0.5;
        } else {
          targetVol = config.musicVolumeIdle ?? 0.5;
        }

        // We only want to set volume automatically if we are playing or connected
        this.setVolume(targetVol, 500);
      });
  }

  private _connectWs(): void {
    try {
      this._ws = new WebSocket(
        `ws://${LOCAL_REST_API_HOST}:${LOCAL_REST_API_PORT}/music/ws`,
      );

      this._ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'MUSIC_STATE') {
            this.isPlaying.set(!!msg.isPlaying);
            this.volume.set(msg.volume ?? 1);
            this.currentTrack.set(msg.currentTrack || '');
            this.currentChapter.set(msg.currentChapter || '');
            this.metadata.set(msg.metadata || null);
          } else if (msg.type === 'MUSIC_TIME') {
            this.currentTime.set(msg.currentTime || 0);
            this.duration.set(msg.duration || 0);
          } else if (msg.type === 'MUSIC_VISUALIZER') {
            this.visualizerData.set(msg.data || new Array(16).fill(0));
            if (msg.isPlaying !== undefined) {
              this.isPlaying.set(!!msg.isPlaying);
            }
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[MusicControlService] Failed to parse message', e);
        }
      };

      this._ws.onclose = () => {
        // eslint-disable-next-line no-console
        console.log('[MusicControlService] WS disconnected. Reconnecting...');
        this._reconnectTimeout = setTimeout(() => this._connectWs(), 3000);
      };

      this._ws.onerror = (e) => {
        // eslint-disable-next-line no-console
        console.error('[MusicControlService] WS Error', e);
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[MusicControlService] Failed to create WebSocket', e);
      this._reconnectTimeout = setTimeout(() => this._connectWs(), 3000);
    }
  }

  sendCommand(action: string, value?: any, fadeMs?: number): void {
    // Send command via REST API
    fetch(`http://${LOCAL_REST_API_HOST}:${LOCAL_REST_API_PORT}/music/command`, {
      method: 'POST',
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, value, fadeMs }),
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e);
    });
  }

  togglePlay(): void {
    this.sendCommand('play_pause');
  }

  next(): void {
    this.sendCommand('next');
  }

  prev(): void {
    this.sendCommand('prev');
  }

  setVolume(vol: number, fadeMs?: number): void {
    this.sendCommand('set_vol', vol, fadeMs);
  }
}
