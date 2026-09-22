import type { CountingMode, ListMessagesOptions, MessageStats, SortKey } from './types.js';

function sortValue(stats: MessageStats, sort: SortKey, counting: CountingMode): number {
  switch (sort) {
    case 'count':
      return counting === 'emit' ? stats.count : stats.sentCount;
    case 'bandwidth':
      return counting === 'emit' ? stats.totalBytes : stats.sentBytes;
    case 'bytes':
      return stats.bytes.p50;
    case 'latency':
      return stats.latency ? stats.latency.p50 : -1;
    default:
      return 0;
  }
}

/**
 * Filtering, sorting and limiting of a message list. Shared by every reader store so the
 * dashboard behaves identically whatever the backend.
 */
export function applyListOptions(
  list: MessageStats[],
  options: ListMessagesOptions = {},
): MessageStats[] {
  const { sort = 'count', counting = 'sent', direction, namespace, limit } = options;

  let out = list;
  if (direction) out = out.filter((s) => s.direction === direction);
  if (namespace) out = out.filter((s) => s.namespace === namespace);

  out = out.slice();
  if (sort === 'name') {
    out.sort((a, b) => a.name.localeCompare(b.name) || a.direction.localeCompare(b.direction));
  } else {
    out.sort(
      (a, b) =>
        sortValue(b, sort, counting) - sortValue(a, sort, counting) ||
        a.name.localeCompare(b.name),
    );
  }

  return limit !== undefined && limit >= 0 ? out.slice(0, limit) : out;
}
