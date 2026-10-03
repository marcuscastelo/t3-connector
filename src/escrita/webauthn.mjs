import { generateAuthenticationOptions, verifyAuthenticationResponse, generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
export class Passkeys {
  #chain = Promise.resolve();
  // rpName e userName só aparecem no cadastro de uma passkey nova; a autenticação usa rpID e o
  // credential id. Trocá-los não invalida passkeys já cadastradas.
  constructor({ origin, rpID, credentials = new Map(), saveCredential, allowLocalhost = false, rpName = 'T3 Connector', userName = 't3-connector' }) {
    const u=new URL(origin);
    if ((u.protocol!=='https:' && !(allowLocalhost && u.protocol==='http:' && u.hostname==='localhost')) || u.origin!==origin || u.hostname!==rpID) throw new Error('invalid_rp');
    Object.assign(this,{origin,rpID,credentials,saveCredential,rpName,userName});
  }
  options(challenge) {
    if (!this.credentials.size) throw new Error('enrollment_required');
    return generateAuthenticationOptions({rpID:this.rpID,challenge:Buffer.from(challenge,'base64url'),userVerification:'required',allowCredentials:[...this.credentials.values()].map(c=>({id:c.id,transports:c.transports}))});
  }
  verify({response,challenge,origin}) {
    // Serialize signature counter verification/update across all concurrent approvals.
    const work=this.#chain.then(async()=>{
      if(origin!==this.origin) throw new Error('origin_invalid');
      const credential=this.credentials.get(response?.id);
      if(!credential) throw new Error('credential_unknown');
      const result=await verifyAuthenticationResponse({response,expectedChallenge:challenge,expectedOrigin:this.origin,expectedRPID:this.rpID,credential,requireUserVerification:true});
      if(!result.verified) throw new Error('assertion_invalid');
      const updated={...credential,counter:result.authenticationInfo.newCounter};
      await this.saveCredential(updated); this.credentials.set(updated.id,updated);
      return updated.id;
    });
    this.#chain=work.catch(()=>{});return work;
  }
  registrationOptions(challenge,userID) {
    return generateRegistrationOptions({rpName:this.rpName,rpID:this.rpID,userName:this.userName,userID,challenge:Buffer.from(challenge,'base64url'),attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'},excludeCredentials:[...this.credentials.values()].map(c=>({id:c.id}))});
  }
  async register(response,challenge) {
    const result=await verifyRegistrationResponse({response,expectedChallenge:challenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true});
    if(!result.verified || !result.registrationInfo) throw new Error('registration_invalid');
    const c={...result.registrationInfo.credential,transports:response.response.transports};
    if(this.credentials.has(c.id)) throw new Error('credential_exists');
    await this.saveCredential(c);this.credentials.set(c.id,c);return c.id;
  }
}
