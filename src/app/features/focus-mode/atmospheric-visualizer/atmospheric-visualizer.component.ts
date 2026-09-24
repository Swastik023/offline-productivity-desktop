import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MusicControlService } from '../music-control.service';

@Component({
  selector: 'atmospheric-visualizer',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (isPlaying()) {
      <div class="eq-hud-container">
        <div class="eq-hud-capsule">
          <div class="eq-bars">
            <span class="bar bar-1"></span>
            <span class="bar bar-2"></span>
            <span class="bar bar-3"></span>
            <span class="bar bar-4"></span>
            <span class="bar bar-5"></span>
            <span class="bar bar-6"></span>
            <span class="bar bar-7"></span>
            <span class="bar bar-8"></span>
          </div>
          <span class="eq-label">AUDIO STREAM ACTIVE</span>
        </div>
      </div>
    }
  `,
  styleUrls: ['./atmospheric-visualizer.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AtmosphericVisualizerComponent {
  private readonly _musicService = inject(MusicControlService);
  readonly isPlaying = this._musicService.isPlaying;
}
