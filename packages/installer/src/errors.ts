/**
 * Typed errors thrown by the installer.
 *
 * Every error pins:
 *   - `step`        — the canonical step name (see {@link InstallStep})
 *                     so callers can branch on which phase failed
 *                     (e.g., "create-requests-db" vs "create-agents-db").
 *   - `workspaceId` — Forge-side workspace primary key for log correlation.
 *   - `cause`       — the original error, preserved via the Error.cause
 *                     standard. Useful when the underlying NotionError has
 *                     a status / body the caller wants to surface.
 */

import type { InstallStep } from './types.js';

export interface InstallerErrorInit {
  step: InstallStep;
  workspaceId: string;
  cause?: unknown;
}

export class InstallerError extends Error {
  public readonly step: InstallStep;
  public readonly workspaceId: string;

  constructor(message: string, init: InstallerErrorInit) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = 'InstallerError';
    this.step = init.step;
    this.workspaceId = init.workspaceId;
  }
}
