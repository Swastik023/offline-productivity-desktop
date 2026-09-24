import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'studio-clock-hud',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="studio-clock-pill"
      [ngClass]="'theme-' + theme"
    >
      <!-- Top Line: Mode & Date -->
      <div class="top-row">
        <span class="mode-tag">{{ statusLabel }}</span>
        <span class="date-chip">{{ dateStr() }}</span>
      </div>

      <!-- Bottom Line: Digital Clock -->
      <div class="time-row">
        <span class="digits">
          {{ hours()
          }}<span
            class="colon"
            [class.blink]="isColonVisible()"
            >:</span
          >{{ minutes() }}
        </span>
        <div class="time-meta">
          <span class="sec-badge">:{{ seconds() }}</span>
          <span class="ampm-badge">{{ ampm() }}</span>
        </div>
      </div>
    </div>
  `,
  styleUrls: ['./studio-clock-hud.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StudioClockHudComponent implements OnInit, OnDestroy {
  @Input() theme: 'emerald' | 'cyan' | 'amber' = 'emerald';
  @Input() statusLabel: string = '☕ BREAK TIME';

  readonly hours = signal<string>('12');
  readonly minutes = signal<string>('00');
  readonly seconds = signal<string>('00');
  readonly ampm = signal<string>('PM');
  readonly dateStr = signal<string>('SAT · AUG 22');
  readonly isColonVisible = signal<boolean>(true);

  private _timer: number | null = null;

  ngOnInit(): void {
    this._tick();
    this._timer = window.setInterval(() => this._tick(), 1000);
  }

  ngOnDestroy(): void {
    if (this._timer) {
      clearInterval(this._timer);
    }
  }

  private _tick(): void {
    const now = new Date();
    const h = now
      .toLocaleTimeString('en-US', { hour: '2-digit', hour12: true })
      .replace(/\s?[AP]M/i, '')
      .trim();
    const m = now.getMinutes().toString().padStart(2, '0');
    const s = now.getSeconds().toString().padStart(2, '0');
    const a = now.getHours() >= 12 ? 'PM' : 'AM';

    const day = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    const mon = now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    const dt = now.getDate();

    this.hours.set(h);
    this.minutes.set(m);
    this.seconds.set(s);
    this.ampm.set(a);
    this.dateStr.set(`${day} · ${mon} ${dt}`);
    this.isColonVisible.set(now.getSeconds() % 2 === 0);
  }
}
