const RELEASE_URL='https://api.github.com/repos/Yubin-spec/Sibyl/releases/latest';
const TRUSTED_HOSTS=new Set(['github.com','objects.githubusercontent.com','github-releases.githubusercontent.com']);

export const versionParts=value=>String(value??'').trim().replace(/^v/i,'').split(/[.+-]/).slice(0,3).map(part=>{const number=Number.parseInt(part,10);return Number.isFinite(number)?number:0;});

export function newerVersion(latest,current){const a=versionParts(latest),b=versionParts(current);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;}

export function trustedAsset(value){try{const url=new URL(value);return url.protocol==='https:'&&TRUSTED_HOSTS.has(url.hostname);}catch{return false;}}

export function pickInstaller(release){const assets=Array.isArray(release?.assets)?release.assets:[];const asset=assets.find(item=>/\.dmg$/i.test(item?.name||'')&&trustedAsset(item?.browser_download_url));return asset?{name:asset.name,url:asset.browser_download_url,size:Number(asset.size)||0}:null;}

export function updateInfo(current,release){const latest=release?String(release.tag_name||'').replace(/^v/i,''):null;return {current,latest,available:!!latest&&newerVersion(latest,current),installer:pickInstaller(release),notes:release?String(release.body||'').slice(0,2000):'',page:release?.html_url||''};}

export async function latestRelease(fetchImpl=fetch){
  let response;
  try{response=await fetchImpl(RELEASE_URL,{headers:{accept:'application/vnd.github+json','user-agent':'AI-Bridge'},signal:AbortSignal.timeout(15000)});}
  catch(error){throw Error('无法连接 GitHub 检查更新：'+error.message);}
  if(response.status===404)return null;
  if(response.status===403)throw Error('GitHub 检查更新频率受限，请稍后再试');
  if(!response.ok)throw Error('检查更新失败 HTTP '+response.status);
  return response.json();
}
