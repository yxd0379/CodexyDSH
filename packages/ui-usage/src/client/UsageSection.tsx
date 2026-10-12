/** Pure Usage settings presentation over the feature-owned query controller. */
import { useEffect, useId } from 'react'
import { Button, IconLoadingOutlineRegular, SegmentedControl } from '@codexydsh/ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsageController } from './controller.ts'
import { NS } from './locales.ts'
import css from './UsageSection.module.css'

/** Controller operations and observable supplied by the plugin. */
export interface UsageSectionInjected {
  readonly hooks: { readonly usage: UsageController['state'] }
  readonly observe: UsageController['observe']
  readonly refresh: UsageController['load']
  readonly select: UsageController['select']
}

/** Render aggregate cards and a model table for the selected interval.
 * @param props - Generated query hook, operations and localized copy.
 * @returns Usage page with query loading, failure and empty states.
 */
export function UsageSection({ useUsage, observe, refresh, select, t }: InjectFace<UsageSectionInjected> & PropsLocale<typeof NS>) {
  const view = useUsage(value => value)
  const id = useId()
  useEffect(observe, [observe])
  const numbers = new Intl.NumberFormat(t('numberLocale'))
  const format = (value: number): string => numbers.format(value)
  const snapshot = view.snapshot
  return <section className={css.section} data-usage>
    <p className={css.secondary}>{t('description')}</p>
    <div className={css.toolbar}>
      <SegmentedControl id={id} label={t('range')} value={view.range} onChange={select}
        options={(['week', 'month', 'all'] as const).map(value => ({ value, label: t(value) }))} />
      <Button variant="outline" disabled={view.busy} onClick={() => { void refresh() }}>{t('refresh')}</Button>
    </div>
    <div id={`${id}-${view.range}-panel`} role="tabpanel" aria-labelledby={`${id}-${view.range}`} aria-busy={view.busy} className={css.content}>
      {(snapshot !== null || view.failed) && <div className={snapshot === null ? css.emptyError : css.notice}>
        {view.failed && <div className={css.error} role="alert"><span>{t('failed')}</span>
          <Button variant="ghost" onClick={() => { void refresh() }}>{t('retry')}</Button>
        </div>}
        {snapshot !== null && !view.failed && <p className={css.secondary}>{t('updated', {
          time: new Intl.DateTimeFormat(t('numberLocale'), { dateStyle: 'medium', timeStyle: 'short' }).format(snapshot.capturedAt),
        })}</p>}
      </div>}
      {snapshot === null ? view.busy && <div className={css.center} role="status" aria-label={t('loading')}>
        <IconLoadingOutlineRegular className={css.spinner} />
      </div> : <>
        <dl className={css.cards}>{([
          ['requests', snapshot.totals.requests], ['total', snapshot.totals.totalTokens],
          ['input', snapshot.totals.inputTokens], ['output', snapshot.totals.outputTokens],
        ] as const).map(([label, value]) => <div className={css.card} key={label}>
          <dt>{t(label)}</dt><dd>{format(value)}</dd>
        </div>)}</dl>
        <h3 className={css.heading}>{t('models')}</h3>
        {snapshot.models.length === 0 ? <p className={css.empty}>{t('empty')}</p> : <div className={css.tableScroll}>
          <table className={css.table} aria-label={t('models')}>
            <thead><tr>{(['model', 'requests', 'input', 'output', 'cached', 'total'] as const)
              .map(key => <th scope="col" key={key}>{t(key)}</th>)}</tr></thead>
            <tbody>{snapshot.models.map(row => <tr key={JSON.stringify([row.provider, row.model])}>
              <th scope="row"><span className={css.model}>{row.model ?? t('unknown')}</span>
                <span className={css.provider}>{row.provider ?? t('unknownProvider')}</span></th>
              {[row.requests, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.totalTokens]
                .map((value, index) => <td key={index}>{format(value)}</td>)}
            </tr>)}</tbody>
          </table>
        </div>}
        {snapshot.totals.reportedRequests < snapshot.totals.requests && <p className={css.secondary}>
          {t('missing', { count: format(snapshot.totals.requests - snapshot.totals.reportedRequests) })}
        </p>}
        <p className={css.secondary}>{t('note')}</p>
      </>}
    </div>
  </section>
}
