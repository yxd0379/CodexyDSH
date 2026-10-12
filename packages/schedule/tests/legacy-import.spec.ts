/** Imported reminders retain the agent-scoped log format through required product facts. */
import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { decodeLegacySession } from '@codexydsh/runtime/persistence'
import { projectProductEvents } from '@codexydsh/runtime/events'
import { ScheduleId, createAfterScheduleRecord, foldScheduleEvents } from '../src/domain.ts'

describe('Schedule released-log import', () => {
  it.each([4, 5])('carries create and dispatch from a v%i log without using the Host task schema', version => {
    const schedule = createAfterScheduleRecord(ScheduleId('schedule-1'), 'remind me', 10, 0)
    const rows = [
      { type: 'session', version, id: 'legacy-schedule', createdAt: 0, isSeeded: false, delegationDepth: 0 },
      { type: 'schedule/change', seq: 0, time: 0, data: { version: 1, operation: 'create', schedule } },
      { type: 'schedule/change', seq: 1, time: 10_000, data: { version: 1, operation: 'dispatch', id: schedule.id } },
    ]
    const imported = decodeLegacySession(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'), 'schedule.jsonl')
    expect(imported.events.slice(0, 2)).toEqual([
      { type: 'codexy/fact', seq: SessionSeq(0), time: 0, data: { type: 'schedule/change', data: rows[1]!.data } },
      { type: 'codexy/fact', seq: SessionSeq(1), time: 10_000, data: { type: 'schedule/change', data: rows[2]!.data } },
    ])
    const events = projectProductEvents(imported.events)
    expect(foldScheduleEvents(events.slice(0, 1)).active).toEqual([schedule])
    expect(foldScheduleEvents(events).active).toEqual([])
  })
})
