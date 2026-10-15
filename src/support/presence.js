export function presenceText(presence) {
  if (!presence?.last_seen_at) return 'Admin activity unavailable';
  if (presence.online) return 'Admin online';
  const minutes = Math.max(1, Math.floor((presence.server_now - presence.last_seen_at - (presence.timeout_seconds || 120) * 1000) / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  const parts = [days && `${days} day${days === 1 ? '' : 's'}`, hours && `${hours} hour${hours === 1 ? '' : 's'}`, rest && `${rest} minute${rest === 1 ? '' : 's'}`].filter(Boolean);
  return 'Admin offline for about ' + parts.join(' ');
}
