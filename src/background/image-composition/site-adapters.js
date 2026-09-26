// Site-specific formats share the existing fetch and image job. An adapter
// only runs on a strong signal: scoped URL flag, or valid JPEG EXIF metadata.
import { omoiCandidate, decodeOmoi } from './omoi.js';
import { vizPage, vizEndpoint, vizSignedUrl, decodeViz } from './viz.js';
import { mangagoKey, decodeMangago } from './mangago.js';
import { kmangaKey, decodeKManga } from './kmanga.js';
import { alphaMangaKey, decodeAlphaManga } from './alpha-manga.js';
import { mangaMiraiKey, decodeMangaMirai } from './manga-mirai.js';

export { vizEndpoint, vizSignedUrl };
export function siteImageCandidate(url,pageUrl) {
  return omoiCandidate(url,pageUrl) || vizPage(pageUrl) || Boolean(mangagoKey(url,pageUrl)) ||
    Boolean(kmangaKey(url,pageUrl)) || Boolean(alphaMangaKey(url,pageUrl)) ||
    Boolean(mangaMiraiKey(url,pageUrl));
}
export async function decodeSiteImage(blob,{url,pageUrl,signal=null,onResult=null}={}) {
  if(omoiCandidate(url,pageUrl))return decodeOmoi(blob,{signal,onResult});
  if(vizPage(pageUrl))return decodeViz(blob,{signal,onResult});
  if(mangagoKey(url,pageUrl))return decodeMangago(blob,url,pageUrl,{signal,onResult});
  if(kmangaKey(url,pageUrl))return decodeKManga(blob,url,pageUrl,{signal,onResult});
  if(alphaMangaKey(url,pageUrl))return decodeAlphaManga(blob,url,pageUrl,{signal,onResult});
  if(mangaMiraiKey(url,pageUrl))return decodeMangaMirai(blob,url,pageUrl,{signal,onResult});
  // A fetched JPEG with the exact VIZ 104-cell EXIF permutation is
  // self-describing even on a mirror host. Missing/ordinary EXIF is a no-op.
  if(blob?.type?.toLowerCase()==='image/jpeg')return decodeViz(blob,{signal,onResult});
  return blob;
}
