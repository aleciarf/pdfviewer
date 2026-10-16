// GitHub stores the data; this Worker keeps the repository write token private.
const REPO = 'aleciarf/pdfviewer';
const FILE = 'shared-notes.json';
const CLIENT_ID = '725283161506-glelre38sq3kaeidarght0fot2111rf0.apps.googleusercontent.com';
const ORIGIN = 'https://pdf-flip.pages.dev';
const empty = () => ({version: 1, books: {}});
const safeKey = value => typeof value === 'string' && /^drive:[\w-]{5,200}$/.test(value);
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
function encode(value) {let binary=''; for (const b of new TextEncoder().encode(value)) binary+=String.fromCharCode(b); return btoa(binary);}
function decode(value) {return new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g,'')),c=>c.charCodeAt(0)));}
export function mergePage(current, patch, base) {
 const next={...current}; const conflicts=[];
 for (const field of ['tags','notes']) if (own(patch,field)) {
  if (current[field]!==base[field] && current[field]!==patch[field]) conflicts.push(field);
  else next[field]=patch[field];
 }
 return {next,conflicts};
}
async function github(env, method, body) {
 const suffix=method==='GET'&&env.GITHUB_BRANCH?'?ref='+encodeURIComponent(env.GITHUB_BRANCH):'';
 return fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}${suffix}`, {
  method,headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:'application/vnd.github+json','User-Agent':'PDF-Flip-Shared-Notes','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})
 });
}
async function readFile(env) {
 const response=await github(env,'GET'); if(response.status===404) {
  // Distinguish a missing file from a missing/inaccessible repository.
  const check=await fetch(`https://api.github.com/repos/${REPO}`,{headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,'User-Agent':'PDF-Flip-Shared-Notes'}});
  if(!check.ok)throw new Error('GitHub repository is inaccessible. Check the Worker secret and repository permissions.');
  return {data:empty(),sha:null};
 }
 if(!response.ok)throw new Error('GitHub read failed (HTTP '+response.status+').');
 const file=await response.json();if(file.encoding!=='base64'||file.size>800000)throw new Error('Shared notes file is too large or invalid.');
 const data=JSON.parse(decode(file.content));if(data.version!==1||!data.books||typeof data.books!=='object'||Array.isArray(data.books))throw new Error('Invalid shared-notes.json.');
 return {data,sha:file.sha};
}
async function verifyGoogle(request) {
 const auth=request.headers.get('Authorization')||'';if(!/^Bearer [^\s]+$/.test(auth))return false;
 const token=auth.slice(7);const response=await fetch('https://oauth2.googleapis.com/tokeninfo?access_token='+encodeURIComponent(token));if(!response.ok)return false;
 const info=await response.json();return (info.aud===CLIENT_ID||info.issued_to===CLIENT_ID)&&Number(info.expires_in)>0&&!!(info.sub||info.user_id);
}
export default {async fetch(request,env) {
 const origin=request.headers.get('Origin'),allowed=env.ALLOWED_ORIGIN||ORIGIN;
 const cors={'Access-Control-Allow-Origin':allowed,'Access-Control-Allow-Methods':'GET,PATCH,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type','Vary':'Origin','Cache-Control':'no-store'};
 const reply=(data,status=200)=>Response.json(data,{status,headers:cors});
 if(origin&&origin!==allowed)return reply({error:'Origin not allowed'},403);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(!env.GITHUB_TOKEN)return reply({error:'Add GITHUB_TOKEN as an encrypted Worker secret.'},503);
 try {
  if(new URL(request.url).pathname!=='/notes')return reply({error:'Not found'},404);
  if(request.method==='GET'){const {data}=await readFile(env);return reply(data);}
  if(request.method!=='PATCH')return reply({error:'Method not allowed'},405);
  if(!await verifyGoogle(request))return reply({error:'Reconnect Google before editing shared notes.'},401);
  const text=await request.text();if(new TextEncoder().encode(text).length>60000)return reply({error:'Edit too large'},413);
  let input;try{input=JSON.parse(text)}catch{return reply({error:'Invalid JSON'},400)}
  if(!safeKey(input.bookKey)||!Number.isInteger(input.page)||input.page<1||input.page>100000||!input.patch||!input.base)return reply({error:'Invalid book or page'},400);
  for(const field of Object.keys(input.patch))if(!['tags','notes'].includes(field)||typeof input.patch[field]!=='string'||input.patch[field].length>(field==='tags'?2000:20000)||typeof input.base[field]!=='string')return reply({error:'Invalid tags or notes'},400);
  if(!Object.keys(input.patch).length)return reply({error:'No changes'},400);
  for(let attempt=0;attempt<5;attempt++) {
   const {data,sha}=await readFile(env),book=data.books[input.bookKey]||{pages:{}},current={tags:'',notes:'',...(book.pages?.[input.page]||{})};
   const {next,conflicts}=mergePage(current,input.patch,input.base);
   if(conflicts.length)return reply({error:'Someone else edited this page.',current,conflicts},409);
   if(next.tags===current.tags&&next.notes===current.notes)return reply({page:current});
   next.updatedAt=new Date().toISOString();book.pages=book.pages||{};book.pages[input.page]=next;data.books[input.bookKey]=book;
   const json=JSON.stringify(data,null,2)+'\n';if(new TextEncoder().encode(json).length>800000)return reply({error:'Shared notes need a larger storage format.'},413);
   const response=await github(env,'PUT',{message:'Update shared page tags and notes [skip ci]',content:encode(json),...(sha?{sha}:{}),...(env.GITHUB_BRANCH?{branch:env.GITHUB_BRANCH}:{})});
   if(response.ok)return reply({page:next});
   if(![409,422].includes(response.status))throw new Error('GitHub save failed (HTTP '+response.status+'). Check token permissions and branch rules.');
  }
  return reply({error:'Another update is being saved. Try again shortly.'},503);
 }catch(error){return reply({error:error.message||'Shared notes unavailable'},502);}
}};
