import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { CloudContextInput, CloudExchangeInput, CloudFactInput } from './memory-bank-cloud.js';

export type MemoryBankCloudSpoolEvent =
  | { id: string; kind: 'context'; createdAt: string; payload: CloudContextInput }
  | { id: string; kind: 'exchange'; createdAt: string; payload: CloudExchangeInput }
  | { id: string; kind: 'fact'; createdAt: string; payload: CloudFactInput };

export class MemoryBankCloudSpool {
  readonly filePath: string;
  private readonly ackPath: string;

  constructor(spoolDir: string) {
    fs.mkdirSync(spoolDir, { recursive: true });
    this.filePath = path.join(spoolDir, 'memory-bank-cloud-spool.jsonl');
    this.ackPath = path.join(spoolDir, 'memory-bank-cloud-acked.jsonl');
    this.corruptPath = path.join(spoolDir, 'memory-bank-cloud-spool.corrupt.jsonl');
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '', 'utf8');
    if (!fs.existsSync(this.ackPath)) fs.writeFileSync(this.ackPath, '', 'utf8');
  }

  enqueue(kind: MemoryBankCloudSpoolEvent['kind'], payload: CloudContextInput | CloudExchangeInput | CloudFactInput): MemoryBankCloudSpoolEvent {
    const event = { id: randomUUID(), kind, createdAt: new Date().toISOString(), payload } as MemoryBankCloudSpoolEvent;
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  readonly corruptPath: string;

  /**
   * Read the spool, separating valid pending events from malformed lines.
   * Malformed lines are NOT dropped from disk — they are returned so callers can
   * report/quarantine them, ensuring one torn line cannot silently strand the queue.
   */
  scan(): { events: MemoryBankCloudSpoolEvent[]; malformed: string[] } {
    const acked = this.readAckedIds();
    const events: MemoryBankCloudSpoolEvent[] = [];
    const malformed: string[] = [];
    for (const line of fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let event: MemoryBankCloudSpoolEvent;
      try {
        event = JSON.parse(line) as MemoryBankCloudSpoolEvent;
      } catch {
        malformed.push(line);
        continue;
      }
      if (event && typeof event.id === 'string' && !acked.has(event.id)) {
        events.push(event);
      }
    }
    return { events, malformed };
  }

  listPending(): MemoryBankCloudSpoolEvent[] {
    return this.scan().events;
  }

  /**
   * Copy malformed lines to a sibling quarantine file for inspection. Non-destructive:
   * the spool file is left intact (append-only), so nothing is lost; this surfaces
   * corruption durably instead of silently skipping it.
   */
  quarantineMalformed(): { quarantined: number; corruptPath: string } {
    const { malformed } = this.scan();
    if (malformed.length > 0) {
      fs.appendFileSync(this.corruptPath, `${malformed.join('\n')}\n`, 'utf8');
    }
    return { quarantined: malformed.length, corruptPath: this.corruptPath };
  }

  ack(eventId: string): void {
    fs.appendFileSync(this.ackPath, `${eventId}\n`, 'utf8');
  }

  private readAckedIds(): Set<string> {
    return new Set(fs.readFileSync(this.ackPath, 'utf8').split(/\r?\n/).filter(Boolean));
  }
}
