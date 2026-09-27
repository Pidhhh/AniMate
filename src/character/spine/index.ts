/* Spine backend registration.
 *
 * Importing this module is what makes 'spine' a selectable character kind.
 * Registration rather than a direct import in CharacterHost keeps the runtime
 * out of the bundle for builds that do not use it.
 */

import { registerCharacterBackend } from '../CharacterHost';
import { SpineBackend } from './SpineBackend';

registerCharacterBackend('spine', () => new SpineBackend());

export { SpineBackend };
