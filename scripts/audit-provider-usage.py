"""Read-only server receipt audit, not a customer invoice. No network requests."""
from __future__ import annotations
import argparse, json, sqlite3, sys
from collections import Counter
from contextlib import closing
from decimal import Decimal, localcontext
from pathlib import Path

def audit(path: Path, engine: str = '') -> dict:
    if not path.is_file():
        raise ValueError(f'Receipt database does not exist: {path}')
    observations=[]; states=Counter(); errors=[]
    # mode=ro cannot accidentally create/overwrite a ledger.
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True)) as db:
        for receipt_id, state, text in db.execute('SELECT receipt_id,state,usage_json FROM provider_usage'):
            try:
                usage=json.loads(text)
                if not isinstance(usage,dict):raise ValueError('usage is not an object')
            except (ValueError,TypeError):
                errors.append(receipt_id);continue
            if engine and usage.get('engine')!=engine:continue
            observations.append(usage);states[state]+=1
    def valid_token(x):return type(x) is int and x >= 0
    def full(u):
        return (u.get('usageStatus')=='reported' and
                all(valid_token(u.get(k)) for k in ('inputTokens','outputTokens','totalTokens')) and
                u['inputTokens']+u['outputTokens']==u['totalTokens'])
    totals={};coverage={}
    for k in ('inputTokens','outputTokens','totalTokens','cachedInputTokens','cacheWriteInputTokens','thinkingTokens'):
        known=[u[k] for u in observations if valid_token(u.get(k))]
        totals[k]=sum(known) if known else None;coverage[k]=len(known)
    costs=[]
    for u in observations:
        try:
            if not isinstance(u.get('providerCostUsd'),str):continue
            v=Decimal(u['providerCostUsd'])
            if v.is_finite() and v >= 0:costs.append(v)
        except Exception:continue
    with localcontext() as ctx:
        ctx.prec=max([len(str(c)) for c in costs]+[28])+len(str(len(costs)))+4
        cost=format(sum(costs,Decimal(0)),'f') if costs else None
    pending=[u.get('receiptId') for u in observations if not full(u)]
    return {'scope':'server_provider_observations_not_customer_invoice','engineFilter':engine or 'all',
        'receiptCount':len(observations),'states':dict(states),'knownTokenSubtotals':totals,
        'coverage':coverage,'completeUsageReceipts':len(observations)-len(pending),
        'pendingOrInconsistentReceiptIds':pending,'malformedReceiptIds':errors,
        'providerCostUsdKnownSubtotal':cost,'costReportedReceipts':len(costs),
        'customerDebitAuthorized':False,
        'note':'No credentials, OCR, prompt or translation text is read. Missing observations are not zero. Unauthenticated/local/browser counters cannot authorize customer billing.'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,default=Path(__file__).resolve().parents[1]/'api/data/ai-usage.sqlite3')
    parser.add_argument('--engine',choices=('runsextension','runsapi'),default='')
    parser.add_argument('--require-complete',action='store_true',help='exit 2 on missing/inconsistent token usage')
    args=parser.parse_args()
    try:result=audit(args.db,args.engine)
    except (ValueError,sqlite3.Error,OSError) as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=False),file=sys.stderr);return 1
    print(json.dumps(result,indent=2,ensure_ascii=False))
    return 2 if args.require_complete and (result['pendingOrInconsistentReceiptIds'] or result['malformedReceiptIds']) else 0
if __name__=='__main__':sys.exit(main())
