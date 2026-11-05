import test from 'node:test';
import assert from 'node:assert/strict';
import {message} from '../plugins/whatsapp/lib/messaging.js';
test('sender display name never replaces sender identity',()=>{
 const m=message({id:'A',chat:'123-456@g.us',sender:'123@lid',authorDisplayName:'Saved Contact',timestamp:1000,type:'text',text:'hello',fromMe:false});
 assert.equal(m.authorId,'123@lid');assert.equal(m.authorDisplayName,'Saved Contact');
 assert.equal(message({id:'B',sender:'456@lid',type:'text',text:'x'}).authorDisplayName,null);
});
