import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
export class MemoryBankCloudSpool {
    filePath;
    ackPath;
    constructor(spoolDir) {
        fs.mkdirSync(spoolDir, { recursive: true });
        this.filePath = path.join(spoolDir, 'memory-bank-cloud-spool.jsonl');
        this.ackPath = path.join(spoolDir, 'memory-bank-cloud-acked.jsonl');
        if (!fs.existsSync(this.filePath))
            fs.writeFileSync(this.filePath, '', 'utf8');
        if (!fs.existsSync(this.ackPath))
            fs.writeFileSync(this.ackPath, '', 'utf8');
    }
    enqueue(kind, payload) {
        const event = { id: randomUUID(), kind, createdAt: new Date().toISOString(), payload };
        fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
        return event;
    }
    listPending() {
        const acked = this.readAckedIds();
        const events = [];
        // Tolerate torn/partial JSONL lines: skip malformed records instead of throwing,
        // so one corrupt line cannot strand every later pending event.
        for (const line of fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/)) {
            if (!line)
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                process.stderr.write('memory-bank-cloud spool: skipping malformed line\n');
                continue;
            }
            if (event && typeof event.id === 'string' && !acked.has(event.id)) {
                events.push(event);
            }
        }
        return events;
    }
    ack(eventId) {
        fs.appendFileSync(this.ackPath, `${eventId}\n`, 'utf8');
    }
    readAckedIds() {
        return new Set(fs.readFileSync(this.ackPath, 'utf8').split(/\r?\n/).filter(Boolean));
    }
}
