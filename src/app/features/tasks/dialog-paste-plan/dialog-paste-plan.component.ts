import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  MatDialogActions,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { TaskService } from '../task.service';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { GlobalConfigService } from '../../config/global-config.service';
import { TagService } from '../../tag/tag.service';
import { ProjectService } from '../../project/project.service';
import { shortSyntax } from '../short-syntax';
import { DEFAULT_GLOBAL_CONFIG } from '../../config/default-global-config.const';
import { Task } from '../task.model';

@Component({
  selector: 'dialog-paste-plan',
  templateUrl: './dialog-paste-plan.component.html',
  styleUrls: ['./dialog-paste-plan.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogTitle,
    MatDialogContent,
    MatFormField,
    MatLabel,
    MatInput,
    FormsModule,
    MatDialogActions,
    MatButton,
  ],
})
export class DialogPastePlanComponent {
  private _matDialogRef = inject<MatDialogRef<DialogPastePlanComponent>>(MatDialogRef);
  private _taskService = inject(TaskService);
  private _globalConfigService = inject(GlobalConfigService);
  private _tagService = inject(TagService);
  private _projectService = inject(ProjectService);

  pastedText = '';
  isProcessing = false;

  async syncPlan() {
    if (!this.pastedText.trim()) {
      this._matDialogRef.close();
      return;
    }

    this.isProcessing = true;
    try {
      const allTasks = await firstValueFrom(this._taskService.allTasks$);
      const allTags = await firstValueFrom(this._tagService.tagsNoMyDayAndNoList$);
      // Use the synchronous signal to get the exact projects currently rendered in the UI,
      // avoiding any race conditions with observables emitting initial state [Inbox]
      const allProjects = this._projectService.list();
      console.log('[PastePlan] allProjects loaded:', allProjects.map(p => ({id: p.id, title: p.title})));
      
      let config = this._globalConfigService.cfg()?.shortSyntax || DEFAULT_GLOBAL_CONFIG.shortSyntax;
      config = {
        ...DEFAULT_GLOBAL_CONFIG.shortSyntax,
        ...config
      };
      
      const lines = this.pastedText.split('\n');

      for (const line of lines) {
        const match = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/) || line.match(/^[-*]\s*(.+)$/);
        if (!match) continue;

        let title = '';
        let isDone = false;

        if (match.length === 3) {
          isDone = match[1].toLowerCase() === 'x';
          title = match[2].trim();
        } else {
          title = match[1].trim();
        }

        if (!title) continue;

        let overrides: any = {
          dueDay: new Date().toISOString().split('T')[0]
        };

        const parseResult = await shortSyntax(
          { title, tagIds: [] },
          config,
          allTags,
          allProjects,
          new Date(),
          'combine',
          true
        );

        if (parseResult) {
          // taskChanges.title is set by shortSyntax when any token (project/tag/date) was consumed
          title = parseResult.taskChanges.title ?? title;
          overrides = { ...overrides, ...parseResult.taskChanges };
          if (parseResult.projectId) {
            overrides.projectId = parseResult.projectId;
          }
          if (parseResult.newTagTitles && parseResult.newTagTitles.length > 0) {
            const newTagIds: string[] = [];
            for (const newTag of parseResult.newTagTitles) {
              const tagId = this._tagService.addTag({ title: newTag });
              newTagIds.push(tagId);
            }
            overrides.tagIds = [...(overrides.tagIds || []), ...newTagIds];
          }
        }
        console.log('[PastePlan] After shortSyntax:', { title, projectId: overrides.projectId, tagIds: overrides.tagIds });

        // Manual fallback for project parsing if shortSyntax missed it
        const plusMatch = title.match(/\+([^\s]+)/);
        if (plusMatch && !overrides.projectId) {
          const projectNameToMatch = plusMatch[1].toLowerCase().replace(/_/g, '');
          const existingProject = allProjects.find(p => 
            p.title.replace(/\s+/g, '').toLowerCase().indexOf(projectNameToMatch) === 0
          );
          if (existingProject) {
            overrides.projectId = existingProject.id;
            title = title.replace(plusMatch[0], '').replace(/\s{2,}/g, ' ').trim();
          } else {
          }
        } else if (plusMatch && overrides.projectId) {
          // If project was assigned but title wasn't cleaned up for some reason
          title = title.replace(plusMatch[0], '').replace(/\s{2,}/g, ' ').trim();
        }

        const existingTask = allTasks.find(t => t.title === title && !t.parentId);

        if (existingTask) {
          if (existingTask.isDone !== isDone) {
            if (isDone) {
              this._taskService.setDone(existingTask.id);
            } else {
              this._taskService.setUnDone(existingTask.id);
            }
          }
          if (overrides.projectId && existingTask.projectId !== overrides.projectId) {
            this._taskService.moveToProject(existingTask as any, overrides.projectId);
          }
        } else {
          const newTaskId = this._taskService.add(title, false, overrides, false, true);
          if (isDone) {
            setTimeout(() => {
              this._taskService.setDone(newTaskId);
            }, 50);
          }
        }
      }
    } catch (e) {
      console.error('Failed to sync paste plan', e);
    }
    
    this._matDialogRef.close();
  }

  cancel() {
    this._matDialogRef.close();
  }
}
