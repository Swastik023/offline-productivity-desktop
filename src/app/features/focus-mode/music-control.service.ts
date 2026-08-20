import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngrx/store';
import { selectCurrentScreen } from './store/focus-mode.selectors';
import { selectFocusModeConfig } from '../config/store/global-config.reducer';
import { FocusScreen } from './focus-mode.model';
import { combineLatest } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { MusicEngineService } from './music-engine.service';

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
  private readonly _store = inject(Store);
  private readonly _musicEngine = inject(MusicEngineService);

  // Delegate signals directly to the central engine
  readonly isPlaying = this._musicEngine.isPlaying;
  readonly volume = this._musicEngine.volume;
  readonly currentTrack = this._musicEngine.currentTrack;
  readonly currentChapter = this._musicEngine.currentChapter;
  readonly metadata = this._musicEngine.metadata;

  readonly currentTime = this._musicEngine.currentTime;
  readonly duration = this._musicEngine.duration;
  readonly visualizerData = this._musicEngine.visualizerData;

  readonly trackDisplayName = this._musicEngine.trackDisplayName;
  readonly trackArtistName = this._musicEngine.trackArtistName;

  constructor() {
    // Volume Orchestration based on Focus Mode screen state
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

        this.setVolume(targetVol, 500);
      });
  }

  togglePlay(): void {
    this._musicEngine.togglePlay();
  }

  next(): void {
    this._musicEngine.next();
  }

  prev(): void {
    this._musicEngine.prev();
  }

  setVolume(vol: number, fadeMs?: number): void {
    this._musicEngine.setVolume(vol, fadeMs);
  }

  seek(seconds: number): void {
    this._musicEngine.seek(seconds);
  }
}
