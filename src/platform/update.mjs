/**
 * GitHub Release 更新检查。
 *
 * 只接受固定仓库和受信任 GitHub 域名下的平台安装包，避免把更新检查变成任意下载入口。
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
 * 从 release assets 里选当前平台的安装包。
 *
 * macOS 选 .dmg，Windows 优先 .exe（NSIS）再选 .msi，
 * 其他平台选 AppImage；下载地址必须通过 trustedAsset 校验。
 */
export function pickInstaller(release, platform = process.platform) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const extensions =
    platform === "win32"
      ? [/\.exe$/i, /\.msi$/i]
      : platform === "darwin"
        ? [/\.dmg$/i]
        : [/\.AppImage$/i];
  let asset = null;
  // 按扩展名优先级查找，避免 Windows 同时发布 exe 和 msi 时受资产顺序影响。
  for (const pattern of extensions) {
    asset = assets.find(
      (item) =>
        pattern.test(item?.name || "") &&
        trustedAsset(item?.browser_download_url),
    );
    if (asset) break;
  }
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
export function updateInfo(current, release, platform = process.platform) {
  const latest = release
    ? String(release.tag_name || "").replace(/^v/i, "")
    : null;
  return {
    current,
    latest,
    available: !!latest && newerVersion(latest, current),
    installer: pickInstaller(release, platform),
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
