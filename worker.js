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
// Refresh credentials are encrypted before leaving the Worker; never stored in GitHub.
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const un64 = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function authKey(env){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode('PDF-Flip-auth-v1:'+env.GOOGLE_CLIENT_SECRET)), 'AES-GCM',false,['encrypt','decrypt']);}
async function seal(env,data){const iv=crypto.getRandomValues(new Uint8Array(12));return b64url(iv)+'.'+b64url(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await authKey(env),new TextEncoder().encode(JSON.stringify(data)))));}
async function unseal(env,text,type){const [iv,data]=text.split('.');const value=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(iv)},await authKey(env),un64(data))));if(value.type!==type||value.exp<Date.now())throw Error('Session expired. Please sign in again.');return value;}
async function googleToken(env,fields){const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID||CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,...fields})});const data=await r.json();if(!r.ok)throw Error(data.error==='invalid_grant'?'Google permission expired. Please sign in again.':'Google could not renew access. Try again.');return data;}
async function authRoute(request,env,reply){
 const url=new URL(request.url),path=url.pathname,callback=url.origin+'/auth/callback';
 if(!env.GOOGLE_CLIENT_SECRET)return reply({error:'Add GOOGLE_CLIENT_SECRET to this Worker.'},503);
 if(path==='/auth/start'&&request.method==='POST'){
  const input=await request.json();if(input.adminPassword!==undefined&&(!env.ADMIN_PASSWORD||input.adminPassword!==env.ADMIN_PASSWORD))return reply({error:'Incorrect admin password, or ADMIN_PASSWORD is not configured.'},403);if(!/^[a-f0-9-]{36}$/.test(input.nonce))return reply({error:'Invalid login request'},400);
  const verifier=b64url(crypto.getRandomValues(new Uint8Array(32))),challenge=b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  const state=await seal(env,{type:'state',nonce:input.nonce,verifier,exp:Date.now()+600000});
  const args=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID||CLIENT_ID,redirect_uri:callback,response_type:'code',scope:'openid email profile https://www.googleapis.com/auth/drive.file'+(input.extra?' https://www.googleapis.com/auth/drive.readonly':'')+(input.adminPassword!==undefined?' https://www.googleapis.com/auth/drive':''),access_type:'offline',prompt:'consent',include_granted_scopes:'true',state,code_challenge:challenge,code_challenge_method:'S256'});
  return reply({url:'https://accounts.google.com/o/oauth2/v2/auth?'+args});
 }
 if(path==='/auth/callback'&&request.method==='GET'){
  let message;try{const state=await unseal(env,url.searchParams.get('state')||'','state');if(url.searchParams.has('error'))throw Error('Google sign-in cancelled.');const t=await googleToken(env,{code:url.searchParams.get('code'),redirect_uri:callback,grant_type:'authorization_code',code_verifier:state.verifier});if(!t.refresh_token)throw Error('No renewal permission received. Please sign in again.');message={type:'pdf-flip-auth',nonce:state.nonce,access_token:t.access_token,expires_in:t.expires_in,scope:t.scope,session:await seal(env,{type:'session',refresh:t.refresh_token,exp:Date.now()+180*86400000})};}catch{message={type:'pdf-flip-auth',error:'Google sign-in failed. Check redirect URI and Worker credentials, then try again.'};}
  const payload=JSON.stringify(message).replace(/</g,'\\u003c');return new Response('<!doctype html><title>PDF Flip sign in</title><p>You can close this window.</p><script>if(window.opener){window.opener.postMessage('+payload+','+JSON.stringify(ORIGIN)+');window.close();}</script>',{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'"}});
 }
 if(path==='/auth/refresh'&&request.method==='POST'){
  let session;try{session=await unseal(env,(request.headers.get('Authorization')||'').replace(/^Bearer /,''),'session');}catch{return reply({error:'Session expired. Please sign in again.'},401)}
  try{const t=await googleToken(env,{refresh_token:session.refresh,grant_type:'refresh_token'});return reply({access_token:t.access_token,expires_in:t.expires_in,scope:t.scope});}catch(error){return reply({error:error.message},error.message.includes('permission expired')?401:502);}
 }
 return reply({error:'Not found'},404);
}
export default {async fetch(request,env) {
 const origin=request.headers.get('Origin'),allowed=env.ALLOWED_ORIGIN||ORIGIN;
 const cors={'Access-Control-Allow-Origin':allowed,'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type','Vary':'Origin','Cache-Control':'no-store'};
 const reply=(data,status=200)=>Response.json(data,{status,headers:cors});
 if(origin&&origin!==allowed)return reply({error:'Origin not allowed'},403);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(new URL(request.url).pathname==='/admin/check'&&request.method==='POST'){
  if(!await verifyGoogle(request))return reply({error:'Sign in to Google first.'},401);
  let input;try{input=await request.json()}catch{return reply({error:'Invalid request'},400)}
  if(!env.ADMIN_PASSWORD)return reply({error:'Add ADMIN_PASSWORD as a Worker secret.'},503);
  if(input.password!==env.ADMIN_PASSWORD)return reply({error:'Incorrect admin password.'},403);
  return reply({ok:true});
 }
 if(new URL(request.url).pathname.startsWith('/auth/')){try{return await authRoute(request,env,reply)}catch{return reply({error:'Google login service unavailable. Check Worker credentials.'},502)}}
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
