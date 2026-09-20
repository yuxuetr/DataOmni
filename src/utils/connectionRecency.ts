/**
 * 连接的「最近使用」时间。
 *
 * 只存在本地：`ConnectionProfile` 上没有 last_used 字段，而「我上次在这台机器上
 * 打开过哪个库」本来就是本机的界面状态，和工作区快照同属一类，不值得为它改后端
 * 的配置存储格式。
 *
 * 不拿 `updated_at` 顶替——那是「最近修改配置」，和「最近用过」是两件事，
 * 用它排序会让界面上的「最近」变成一句假话。
 */
const STORAGE_KEY = 'dataomni_connection_recency';

/** 上限只为防止已删除连接的残留条目无限增长；正常使用远达不到 */
const MAX_ENTRIES = 50;

export type ConnectionRecency = Record<string, number>;

function isRecencyMap(value: unknown): value is ConnectionRecency {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(
    (timestamp) => typeof timestamp === 'number' && Number.isFinite(timestamp)
  );
}

export function loadConnectionRecency(): ConnectionRecency {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    return isRecencyMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function recordConnectionUse(profileId: string, now: number = Date.now()): void {
  const recency = { ...loadConnectionRecency(), [profileId]: now };

  const trimmed = Object.entries(recency)
    .sort(([, left], [, right]) => right - left)
    .slice(0, MAX_ENTRIES);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // 存储不可用时排序退化为原有顺序，不影响连接本身
  }
}

/**
 * 用过的排前面（近的更前），没用过的保持传入顺序排在后面。
 * 不做写入——排序是读操作。
 */
export function orderProfilesByRecency<T extends { id: string }>(
  profiles: readonly T[],
  recency: ConnectionRecency = loadConnectionRecency()
): T[] {
  const used: { profile: T; usedAt: number }[] = [];
  const unused: T[] = [];

  for (const profile of profiles) {
    const usedAt = recency[profile.id];
    if (typeof usedAt === 'number') {
      used.push({ profile, usedAt });
    } else {
      unused.push(profile);
    }
  }

  used.sort((left, right) => right.usedAt - left.usedAt);
  return [...used.map((entry) => entry.profile), ...unused];
}
