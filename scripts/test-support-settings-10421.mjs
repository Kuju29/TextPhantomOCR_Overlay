import assert from 'node:assert/strict';
import {translationSettingsChanged as changed} from '../src/background/translation-settings.js';
const login={paidSessionToken:{oldValue:'',newValue:'verified'},paidApiBase:{oldValue:'',newValue:'https://api.example'}};
const logout={paidSessionToken:{oldValue:'verified',newValue:''}};
for(const mode of ['manual','local']){
  assert.equal(changed(login,'local',mode),false,'Support login cannot cancel '+mode);
  assert.equal(changed(logout,'local',mode),false,'Support logout cannot cancel '+mode);
  assert.equal(changed({paidModel:{oldValue:'a',newValue:'b'}},'local',mode),false);
  assert.equal(changed({paidAiProfilesV1:{oldValue:{},newValue:{a:{thinking:'off'}}}},'local',mode),false);
}
assert.equal(changed(login,'local','paid'),true);
assert.equal(changed(logout,'local','paid'),true);
assert.equal(changed({...login,aiServiceMode:{oldValue:'manual',newValue:'paid'}},'local','manual'),true);
assert.equal(changed({lang:{oldValue:'th',newValue:'en'}},'local','manual'),true);
assert.equal(changed({supportDockView:{oldValue:'hidden',newValue:'expanded'}},'local','paid'),false);
assert.equal(changed({supportUnread:{newValue:{unread:3}}},'local','manual'),false);
console.log('Support/translation settings isolation: 14 assertions passed');
