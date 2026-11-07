/**
 * GitHub Release 更新检查。
 *
 * 只接受固定仓库和受信任 GitHub 域名下的 DMG，避免把更新检查变成任意下载入口。
 * 本模块只返回更新信息，不自动安装。
 */
const RELEASE_URL =
  "https://api.github.com/repos/Yubin-spec/Sibyl/releases/latest";
const TRUSTED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

/**
 * 把版本号拆成三个数字。
 *
 * 去掉 v 前缀，按 . + - 分段，最多取三段；
 * 非数字段按 0 处理，保证比较不会因 NaN 出错。
 */
export const versionParts = (value) =>
  String(value ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    });

/**
 * 判断 latest 是否比 current 新。
 *
 * 逐段比较主/次/补丁版本；完全相同返回 false。
 */
export function newerVersion(latest, current) {
  const a = versionParts(latest),
    b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * 校验下载地址是否可信。
 *
 * 只允许 https 和固定 GitHub 域名，避免更新检查被利用下载任意文件。
 */
export function trustedAsset(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && TRUSTED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 从 release assets 里选 DMG。
 *
 * 只接受 .dmg 且下载地址通过 trustedAsset 校验的资产。
 */
export function pickInstaller(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find(
    (item) =>
      /\.dmg$/i.test(item?.name || "") &&
      trustedAsset(item?.browser_download_url),
  );
  return asset
    ? {
        name: asset.name,
        url: asset.browser_download_url,
        size: Number(asset.size) || 0,
      }
    : null;
}

/**
 * 生成 UI 所需的更新信息。
 *
 * 返回当前版本、最新版本、是否有更新、安装包元数据、发布说明和页面地址。
 */
export function updateInfo(current, release) {
  const latest = release
    ? String(release.tag_name || "").replace(/^v/i, "")
    : null;
  return {
    current,
    latest,
    available: !!latest && newerVersion(latest, current),
    installer: pickInstaller(release),
    notes: release ? String(release.body || "").slice(0, 2000) : "",
    page: release?.html_url || "",
  };
}

/**
 * 查询 GitHub 最新 release。
 *
 * 15 秒超时；404 表示还没有发布，返回 null；
 * 403 通常是被限流，转换成用户能理解的中文提示。
 */
export async function latestRelease(fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(RELEASE_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Agents-Calling",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw Error("无法连接 GitHub 检查更新：" + error.message);
  }
  if (response.status === 404) return null;
  if (response.status === 403)
    throw Error("GitHub 检查更新频率受限，请稍后再试");
  if (!response.ok) throw Error("检查更新失败 HTTP " + response.status);
  return response.json();
}
