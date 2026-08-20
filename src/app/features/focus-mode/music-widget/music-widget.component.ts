import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSliderModule } from '@angular/material/slider';
import { MusicControlService } from '../music-control.service';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'music-widget',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatButtonModule, MatSliderModule, FormsModule],
  templateUrl: './music-widget.component.html',
  styleUrl: './music-widget.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MusicWidgetComponent {
  musicService = inject(MusicControlService);
  
  isExpanded = signal<boolean>(false);

  toggleExpand() {
    this.isExpanded.set(!this.isExpanded());
  }

  onVolumeChange(event: any) {
    // The material slider emits the new value
    const vol = event.target ? event.target.value : event;
    if (typeof vol === 'number') {
      this.musicService.setVolume(vol);
    }
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
}
