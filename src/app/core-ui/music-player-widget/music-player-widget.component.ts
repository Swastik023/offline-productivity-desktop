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
import { trigger, state, style, transition, animate } from '@angular/animations';
import { Store } from '@ngrx/store';
import { Subscription } from 'rxjs';
import { GlobalConfigService } from '../../features/config/global-config.service';
import { selectCurrentScreen } from '../../features/focus-mode/store/focus-mode.selectors';
import { FocusScreen } from '../../features/focus-mode/focus-mode.model';
import { IS_ELECTRON } from '../../app.constants';
import { FormsModule } from '@angular/forms';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MusicEngineService } from '../../features/focus-mode/music-engine.service';
import {
  LOCAL_REST_API_HOST,
  LOCAL_REST_API_PORT,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';

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
  readonly musicEngine = inject(MusicEngineService);

  isExpanded = signal<boolean>(false);

  // Settings
  musicFolder = signal<string | null>(null);
  shuffleMode = signal<boolean>(false);
  enableModeVolume = signal<boolean>(false);
  focusVolume = signal<number>(1);
  breakVolume = signal<number>(1);

  readonly IS_ELECTRON = IS_ELECTRON;
  private _subs = new Subscription();

  // Signals delegated from MusicEngineService
  readonly isPlaying = this.musicEngine.isPlaying;
  readonly volume = this.musicEngine.volume;
  readonly trackList = this.musicEngine.trackList;
  readonly currentChapter = this.musicEngine.currentChapter;
  readonly currentMetadata = this.musicEngine.metadata;
  readonly currentTime = this.musicEngine.currentTime;
  readonly duration = this.musicEngine.duration;

  readonly currentTrackName = computed(() => {
    return this.formatCleanName(this.musicEngine.currentTrack());
  });

  readonly thumbnailUrl = computed(() => {
    const track = this.musicEngine.currentTrack();
    if (!track) return null;
    return `http://${LOCAL_REST_API_HOST}:${LOCAL_REST_API_PORT}/music/art?file=${encodeURIComponent(track)}`;
  });

  formatCleanName(filename: string): string {
    if (!filename) return '';
    return filename
      .replace(/\.(mp3|wav|ogg)$/i, '')
      .replace(/\s*\[.*?\]\s*$/, '') // remove youtube bracket IDs like [Yd7vDterctQ]
      .replace(/[-_]/g, ' ');
  }

  ngOnInit(): void {
    // Subscribe to config changes
    this._subs.add(
      this._globalConfigService.misc$.subscribe((misc) => {
        this.musicFolder.set(misc.localMusicFolderPath || null);
        const isShuffle = !!misc.musicShuffleMode;
        this.shuffleMode.set(isShuffle);
        this.musicEngine.setShuffle(isShuffle);

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
          this.musicEngine.setVolume(this.focusVolume());
        } else if (screen === FocusScreen.Break) {
          this.musicEngine.setVolume(this.breakVolume());
        }
      }),
    );
  }

  ngOnDestroy(): void {
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
      setTimeout(() => this.musicEngine.fetchTrackList(), 500);
    }
  }

  toggleShuffle(): void {
    const newVal = !this.shuffleMode();
    this._globalConfigService.updateSection('misc', {
      musicShuffleMode: newVal,
    });
    this.shuffleMode.set(newVal);
    this.musicEngine.setShuffle(newVal);
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
    this.musicEngine.playTrackByName(trackName);
  }

  playChapter(startTime: number): void {
    this.musicEngine.seek(startTime);
  }

  skipForward(): void {
    this.musicEngine.skipForward();
  }

  skipBackward(): void {
    this.musicEngine.skipBackward();
  }

  seekTo(event: MouseEvent, progressBar: HTMLElement): void {
    if (!this.duration()) return;
    const rect = progressBar.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    this.musicEngine.seek(percentage * this.duration());
  }

  formatTime(seconds: number): string {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0)
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  refreshTracks(): void {
    this.musicEngine.fetchTrackList();
  }

  sendCommand(action: string, value?: number | string): void {
    if (action === 'play_pause') {
      this.musicEngine.togglePlay();
    } else if (action === 'set_vol' && typeof value === 'number') {
      this.musicEngine.setVolume(value);
    } else if (action === 'next') {
      this.musicEngine.next();
    } else if (action === 'prev') {
      this.musicEngine.prev();
    } else if (action === 'seek_time' && typeof value === 'number') {
      this.musicEngine.seek(value);
    } else if (action === 'set_track' && typeof value === 'string') {
      this.musicEngine.playTrackByName(value);
    } else if (action === 'skip_forward') {
      this.musicEngine.skipForward();
    } else if (action === 'skip_backward') {
      this.musicEngine.skipBackward();
    }
  }
}
