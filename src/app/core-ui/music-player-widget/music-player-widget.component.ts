import {
  Component,
  ChangeDetectionStrategy,
  signal,
  OnInit,
  OnDestroy,
  inject,
  ChangeDetectorRef,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSliderModule } from '@angular/material/slider';
import { HttpClient } from '@angular/common/http';
import { trigger, state, style, transition, animate } from '@angular/animations';
import { Store } from '@ngrx/store';
import { Subscription } from 'rxjs';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { selectCurrentScreen } from '../../features/focus-mode/store/focus-mode.selectors';
import { FocusScreen } from '../../features/focus-mode/focus-mode.model';
import { IS_ELECTRON } from '../../app.constants';
import { FormsModule } from '@angular/forms';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

@Component({
  selector: 'music-player-widget',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatSliderModule,
    FormsModule,
    MatSlideToggleModule,
  ],
  templateUrl: './music-player-widget.component.html',
  styleUrl: './music-player-widget.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('expandCollapse', [
      state('collapsed', style({ height: '0', opacity: '0', overflow: 'hidden' })),
      state('expanded', style({ height: '*', opacity: '1' })),
      transition(
        'collapsed <=> expanded',
        animate('250ms cubic-bezier(0.4, 0.0, 0.2, 1)'),
      ),
    ]),
  ],
})
export class MusicPlayerWidgetComponent implements OnInit, OnDestroy {
  private readonly _store = inject(Store);
  private readonly _globalConfigService = inject(GlobalConfigService);
  private readonly _cd = inject(ChangeDetectorRef);

  isPlaying = signal<boolean>(false);
  currentTrackName = signal<string>('No track selected');
  volume = signal<number>(1);
  isExpanded = signal<boolean>(false);
  trackList = signal<string[]>([]);

  // Settings
  musicFolder = signal<string | null>(null);
  shuffleMode = signal<boolean>(false);
  enableModeVolume = signal<boolean>(false);
  focusVolume = signal<number>(1);
  breakVolume = signal<number>(1);

  readonly IS_ELECTRON = IS_ELECTRON;
  private ws: WebSocket | null = null;
  private wsReconnectTimer: any;
  private _subs = new Subscription();
  public currentChapter = signal<string>('');
  public currentMetadata = signal<any>(null);
  public thumbnailUrl = computed(() => {
    const track = this.currentTrackName();
    if (!track) return null;
    return `http://127.0.0.1:3876/music/thumbnail?file=${encodeURIComponent(track)}`;
  });
  public currentTime = signal(0);
  public duration = signal(0);

  private readonly _http = inject(HttpClient);

  formatCleanName(filename: string): string {
    if (!filename) return '';
    return filename
      .replace(/\.(mp3|wav|ogg)$/i, '')
      .replace(/\s*\[.*?\]\s*$/, '') // remove youtube bracket IDs like [Yd7vDterctQ]
      .replace(/[-_]/g, ' ');
  }

  ngOnInit(): void {
    this._connectWebSocket();
    this._fetchTrackList();

    // Subscribe to config changes
    this._subs.add(
      this._globalConfigService.misc$.subscribe((misc) => {
        this.musicFolder.set(misc.localMusicFolderPath || null);
        this.shuffleMode.set(!!misc.musicShuffleMode);
        this.enableModeVolume.set(!!misc.enableMusicModeVolume);
        this.focusVolume.set(misc.musicFocusVolume ?? 1);
        this.breakVolume.set(misc.musicBreakVolume ?? 1);
        this._cd.detectChanges();
      }),
    );

    // Subscribe to Focus Mode state for volume auto-adjust
    this._subs.add(
      this._store.select(selectCurrentScreen).subscribe((screen) => {
        if (!this.enableModeVolume()) return;

        if (screen === FocusScreen.Main) {
          this.sendCommand('set_vol', this.focusVolume());
        } else if (screen === FocusScreen.Break) {
          this.sendCommand('set_vol', this.breakVolume());
        }
        // WaitingForNextFocus does nothing
      }),
    );
  }

  ngOnDestroy(): void {
    if (this.ws) {
      this.ws.close();
    }
    clearTimeout(this.wsReconnectTimer);
    this._subs.unsubscribe();
  }

  toggleExpanded(): void {
    this.isExpanded.set(!this.isExpanded());
  }

  async selectMusicFolder(): Promise<void> {
    if (!IS_ELECTRON) return;
    const path = await window.ea.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Music Folder',
      defaultPath: this.musicFolder() || undefined,
    });

    if (path && path.length > 0) {
      this._globalConfigService.updateSection('misc', {
        localMusicFolderPath: path[0],
      });
      // Notify backend overlay
      this.sendCommand('set_music_folder');
      // Wait a tiny bit and refetch tracklist
      setTimeout(() => this._fetchTrackList(), 500);
    }
  }

  toggleShuffle(): void {
    const newVal = !this.shuffleMode();
    this._globalConfigService.updateSection('misc', {
      musicShuffleMode: newVal,
    });
    this.sendCommand('set_shuffle', newVal ? 1 : 0);
  }

  toggleModeVolume(): void {
    const newVal = !this.enableModeVolume();
    this._globalConfigService.updateSection('misc', {
      enableMusicModeVolume: newVal,
    });
  }

  updateFocusVolume(val: number): void {
    this._globalConfigService.updateSection('misc', {
      musicFocusVolume: val,
    });
  }

  updateBreakVolume(val: number): void {
    this._globalConfigService.updateSection('misc', {
      musicBreakVolume: val,
    });
  }

  playTrack(trackName: string): void {
    this.sendCommand('set_track', trackName as any);
  }

  playChapter(startTime: number): void {
    this.sendCommand('seek_time', startTime);
  }

  skipForward(): void {
    this.sendCommand('skip_forward');
  }

  skipBackward(): void {
    this.sendCommand('skip_backward');
  }

  seekTo(event: MouseEvent, progressBar: HTMLElement): void {
    if (!this.duration()) return;
    const rect = progressBar.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    this.sendCommand('seek_time', percentage * this.duration());
  }

  formatTime(seconds: number): string {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  refreshTracks(): void {
  }

  private _connectWebSocket(): void {
    this.ws = new WebSocket('ws://localhost:3876/music/ws');
    this.ws.onopen = () => {
      // eslint-disable-next-line no-console
      console.log('[MusicPlayerWidget] Connected to local music WS');
      // Sync shuffle state on connect
      if (this.shuffleMode()) {
        this.sendCommand('set_shuffle', 1);
      }
    };
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
                if (msg.type === 'MUSIC_TIME') {
          if (msg.currentTime !== undefined) this.currentTime.set(msg.currentTime);
          if (msg.duration !== undefined) this.duration.set(msg.duration);
          this._cd.detectChanges();
          return;
        }
        if (msg.type === 'MUSIC_STATE') {
          if (msg.currentTrack !== undefined) {
            this.currentTrackName.set(this.formatCleanName(msg.currentTrack));
          }
          if (msg.currentChapter !== undefined) {
            this.currentChapter.set(msg.currentChapter);
          }
          if (msg.metadata !== undefined) {
            this.currentMetadata.set(msg.metadata);
          }
          if (msg.isPlaying !== undefined) this.isPlaying.set(msg.isPlaying);
          if (msg.volume !== undefined) this.volume.set(msg.volume);
          this._cd.detectChanges();
        }
      } catch (e) {}
    };
    this.ws.onclose = () => {
      // eslint-disable-next-line no-console
      console.log('[MusicPlayerWidget] WS disconnected. Reconnecting in 3s...');
      this.wsReconnectTimer = setTimeout(() => this._connectWebSocket(), 3000);
    };
  }

  private _fetchTrackList(): void {
    this._http.get<{ files: string[] }>('http://localhost:3876/music/list').subscribe({
      next: (res) => {
        if (res.files) {
          this.trackList.set(res.files);
          if (res.files.length > 0 && this.currentTrackName() === 'No track selected') {
            this.currentTrackName.set(this.formatCleanName(res.files[0]));
          }
          this._cd.detectChanges();
        }
      },
      error: (
        err, // eslint-disable-next-line no-console
      ) => console.warn('[MusicPlayerWidget] Failed to fetch track list', err),
    });
  }

  sendCommand(action: string, value?: number | string): void {
    if (action === 'play_pause') {
      this.isPlaying.set(!this.isPlaying());
    } else if (action === 'set_vol' && typeof value === 'number') {
      this.volume.set(value);
    }

    this._http.post(`http://localhost:3876/music/command`, { action, value }).subscribe({
      error: (err) =>
        // eslint-disable-next-line no-console
        console.error('[MusicPlayerWidget] Failed to send music command', err),
    });
  }
}
