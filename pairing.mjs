import {randomInt,randomBytes,randomUUID,createHash} from 'node:crypto';
import {isIP} from 'node:net';
const uuid=v=>typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const safe=v=>typeof v==='string' && /^[\p{L}\p{N} _.-]{1,80}$/u.test(v);
export function safeDevice(v){if(!v || !uuid(v.id)||!safe(v.name)||!safe(v.owner)) throw Error('Invalid device metadata');return {id:v.id,name:v.name,owner:v.owner};}
function safeReverse(v,ip){
 let u;try{u=new URL(v.url);}catch{throw Error('Invalid reverse URL');}
 const parts=u.hostname.split('.').map(Number),privateIP=isIP(u.hostname)===4 && (parts[0]===10 || parts[0]===192&&parts[1]===168 || parts[0]===172&&parts[1]>=16&&parts[1]<=31);
 if(u.protocol!=='http:'||!privateIP||u.hostname!==ip||!/^http:\/\/[^/]+:\d+\/?$/.test(v.url)||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!Number(u.port||80)||!/^[a-f0-9]{64}$/i.test(v.token||'')||!uuid(v.peerId)) throw Error('Invalid reverse address or credentials');
 return {url:u.origin,token:v.token,peerId:v.peerId};
}
const hash=value=>createHash('sha256').update(value).digest('hex');
export function createPairing({peers,save,notify=()=>{},now=Date.now,onApproved,metadata,onChange=()=>{}}) {
  metadata=metadata?safeDevice(metadata):undefined;
  let code=String(randomInt(10000000,100000000)),expires=now()+300000;
  const pending=new Map(),attempts=new Map();
  const prune=()=>{for(const [id,r] of pending) if(r.expires<now()) pending.delete(id);for(const [ip,r] of attempts) if(r.until<now()) attempts.delete(ip);};
  return {
    get code(){return code;},
    rotate(){code=String(randomInt(10000000,100000000));expires=now()+300000;return code;},
    start(body,ip){
      prune();ip=String(ip).replace(/^::ffff:/,'');
      const device=body?.device===undefined?undefined:safeDevice(body.device);
      const reverse=body?.reverse===undefined?undefined:safeReverse(body.reverse,ip);
      if(attempts.size>1000 && !attempts.has(ip)) throw Error('Too many requests');
      const count=attempts.get(ip)||{n:0,until:now()+60000};attempts.set(ip,count);
      if(++count.n>5) throw Error('Too many attempts; wait one minute');
      if(now()>expires) throw Error('Pairing code expired; ask host to rotate');
      if(body?.code!==code || typeof body.name!=='string' || !/^[\p{L}\p{N} _.-]{1,60}$/u.test(body.name)) throw Error('Invalid pairing code or name');
      if(pending.size>=20) throw Error('Too many pending requests');
      const request={id:randomUUID(),secret:randomBytes(32).toString('hex'),name:body.name,device,reverse,ip,status:'pending',expires:now()+300000};
      pending.set(request.id,request);notify({id:request.id,name:request.name,ip,device});onChange({type:'pair-request',id:request.id});
      return {id:request.id,secret:request.secret};
    },
    async approve(id,accepted){
      prune();const r=pending.get(id);if(!r || r.status!=='pending') throw Error('Unknown pending request');
      if(!accepted){r.status='denied';onChange({type:'pair-denied',id});return;}
      r.status='approving';
      const token=randomBytes(32).toString('hex'),peerId=randomUUID();
      peers[peerId]={id:peerId,name:r.name,hash:hash(token),deviceId:r.device?.id,owner:r.device?.owner,created:new Date(now()).toISOString()};
      try{await save();await onApproved?.({request:r,peer:peers[peerId],token});}catch(e){delete peers[peerId];r.status='pending';await save();throw e;}
      Object.assign(r,{status:'approved',token,peerId});onChange({type:'pair-approved',id,peerId});
    },
    result(id,secret){
      prune();const r=pending.get(id);if(!r || hash(String(secret))!==hash(r.secret)) throw Error('Unknown pairing request');
      if(['pending','approving'].includes(r.status)) return {status:'pending'};
      pending.delete(id);return {status:r.status,token:r.token,peerId:r.peerId,...(metadata?{device:metadata}:{})};
    },
    authenticate(token){const digest=hash(token);return Object.values(peers).find(peer=>peer.enabled!==false && peer.hash===digest)||null;},
    async grant({name,deviceId,owner,enabled=false}){
      if(!safe(name)||deviceId!==undefined&&!uuid(deviceId)||owner!==undefined&&!safe(owner)||typeof enabled!=='boolean') throw Error('Invalid peer metadata');
      const peerId=randomUUID(),token=randomBytes(32).toString('hex');peers[peerId]={id:peerId,name,deviceId,owner,enabled,hash:hash(token),created:new Date(now()).toISOString()};
      try{await save();}catch(e){delete peers[peerId];throw e;}return {peerId,token};
    },
    async activate(id){const peer=peers[id];if(!peer) throw Error('Unknown peer');const old=peer.enabled;peer.enabled=true;try{await save();}catch(e){peer.enabled=old;throw e;}onChange({type:'pair-activated',peerId:id});},
    async revoke(id){if(!Object.hasOwn(peers,id)) throw Error('Unknown peer');const peer=peers[id];delete peers[id];try{await save();}catch(e){peers[id]=peer;throw e;}onChange({type:'pair-revoked',peerId:id});},
  };
}
