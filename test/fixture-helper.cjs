#!/usr/bin/env node
// Offline provider fixture; not part of the installed plugin or helper release.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),{DatabaseSync}=require('node:sqlite'),{randomUUID}=require('node:crypto');
const dir=process.argv[process.argv.indexOf('--data-dir')+1];fs.mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(path.join(dir,'fixture.db'));
db.exec('CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY,instance TEXT,revoked INTEGER,through_seq INTEGER);CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chat TEXT,payload TEXT);CREATE TABLE IF NOT EXISTS feed(seq INTEGER PRIMARY KEY AUTOINCREMENT,chat TEXT,messageId TEXT,kind TEXT);CREATE TABLE IF NOT EXISTS writes(id INTEGER PRIMARY KEY AUTOINCREMENT,method TEXT);');
const chat='987654321@s.whatsapp.net',account='123456789@s.whatsapp.net';
const version=JSON.parse(fs.readFileSync(path.join(__dirname,'../plugins/whatsapp/plugin.json'),'utf8')).version;
const emit=()=>process.stdout.write(JSON.stringify({event:'changes'})+'\n');
function ingest(id,text,extra={}){
 const raw={id,chat,sender:chat,fromMe:false,timestamp:Date.now(),text,type:'text',...extra};
 db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?,?)').run(id,chat,JSON.stringify(raw));
 db.prepare("INSERT INTO feed(chat,messageId,kind) VALUES(?,?,'invalidated')").run(chat,id);emit();return raw;
}
if(!db.prepare('SELECT 1 FROM state WHERE id=1').get()){
 db.prepare('INSERT INTO state VALUES(1,?,0,0)').run(randomUUID().replaceAll('-',''));
 ingest('M1','Hello',{timestamp:1000,fromMe:true,sender:account,reactions:[{emoji:'👍',count:null,me:null,users:[{id:chat,displayName:'Fixture contact'}],usersComplete:false}]});
 ingest('M2','PRIVATE-RESTRICTED',{type:'restricted',timestamp:2000});
 ingest('M3','PRIVATE-DELETED',{type:'revoked',timestamp:3000});
 ingest('M4','',{type:'audio',timestamp:4000});
}
const fault=(code,status=400,definitive=true)=>({code,status,definitive});
function dispatch(method,a){
 const state=db.prepare('SELECT * FROM state WHERE id=1').get();
 if(method==='version')return {version,protocol:1,features:['changes.v1']};
 if(method==='status'||method==='pairingStatus')return {ready:!state.revoked,paired:true,revoked:!!state.revoked,account,cacheHealthy:true};
 if(method==='start'){if(state.revoked)throw fault('session_revoked',401);return {ready:true,paired:true,account};}
 if(method==='chats')return {items:[{id:chat,name:'Fixture',isGroup:false,lastMessageAt:4000}],nextCursor:a.cursor?null:'native-next',hasMore:!a.cursor,coverage:'synced_cache_only'};
 if(method==='chat'){if(a.chat!==chat)throw fault('chat_not_in_synced_cache',404);return {id:chat,name:'Fixture',isGroup:false,lastMessageAt:4000};}
 if(method==='messages'){
  const rows=db.prepare('SELECT payload FROM messages WHERE chat=? ORDER BY id').all(a.chat);const offset=a.cursor?Number(a.cursor):0;
  if(!Number.isSafeInteger(offset)||offset<0)throw fault('invalid_cursor');const end=offset+(a.limit||50);
  return {items:rows.slice(offset,end).map(r=>JSON.parse(r.payload)),nextCursor:rows.length>end?String(end):null,hasMore:rows.length>end,coverage:'synced_cache_only'};
 }
 if(method==='message'){const row=db.prepare('SELECT payload FROM messages WHERE chat=? AND id=?').get(a.chat,a.messageId);if(!row)throw fault('message_not_in_synced_cache',404);return JSON.parse(row.payload);}
 if(method==='send'||method==='react'){
  db.prepare('INSERT INTO writes(method) VALUES(?)').run(method);
  if(a.text==='UNCERTAIN')throw fault('send_uncertain',502,false);
  if(a.replyTo==='M4')throw fault('reply_context_unavailable',409);
  if(method==='send')ingest(a.sendId,a.text,{fromMe:true,sender:account,replyTo:a.replyTo});
  return {ok:true,messageId:a.sendId,chat:a.chat};
 }
 if(method==='changes'){
  const head=db.prepare('SELECT coalesce(max(seq),0) n FROM feed').get().n;let cursor;
  try{cursor=a.cursor?JSON.parse(Buffer.from(a.cursor,'base64url').toString()):null;}catch{throw fault('invalid_cursor');}
  const resync=!cursor||cursor.instance!==state.instance||cursor.seq<state.through_seq||cursor.seq>head;
  let events=resync?[]:db.prepare('SELECT seq,chat,messageId,kind FROM feed WHERE seq>? ORDER BY seq LIMIT ?').all(cursor.seq,(a.limit||100)+1);
  const hasMore=events.length>(a.limit||100);events=events.slice(0,a.limit||100);const next=events.length?events.at(-1).seq:head;
  return {instance:state.instance,head:next,checkpoint:Buffer.from(JSON.stringify({instance:state.instance,seq:next})).toString('base64url'),events,resync,hasMore};
 }
 if(method==='fixture.emit')return ingest(a.id||'NEW',a.text||'New');
 if(method==='fixture.expire'){db.exec('UPDATE state SET revoked=1');emit();return {};}
 if(method==='fixture.restore'){db.exec('UPDATE state SET revoked=0');emit();return {};}
 if(method==='fixture.writeCount')return {count:db.prepare('SELECT count(*) n FROM writes').get().n};
 throw fault('unsupported_method');
}
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='fixture.hang')return;try{const result=dispatch(r.method,r.args||{});process.stdout.write(JSON.stringify({id:r.id,result})+'\n');}catch(error){process.stdout.write(JSON.stringify({id:r.id,error:error.code?error:fault('fixture_failed',500,false)})+'\n');}}).on('close',()=>db.close());
