/** Display only. Center remains the sole authority for charging credits. */
export function formatPaidTpRate(value, ceiling = false) {
  if (typeof value !== 'string' || value.length>80 || !/^\d+(?:\.\d+)?$/.test(value)) return '—';
  const [integer,fraction='']=value.split('.');
  const whole=BigInt(integer), positiveFraction=/[1-9]/.test(fraction);
  if (whole===0n && positiveFraction) return '<1';
  const rounded=whole + ((ceiling ? positiveFraction : Number(fraction[0] || 0)>=5) ? 1n : 0n);
  return rounded.toLocaleString('en-US');
}
