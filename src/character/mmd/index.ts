/* MMD backend registration.
 *
 * Importing this module is what makes 'mmd' a selectable character kind.
 *
 * The registration is deliberately *lazy* — the factory is only called when a
 * model of this kind is actually mounted — but the import itself is static, so
 * Babylon and babylon-mmd are in the bundle regardless. They are a large
 * dependency (~2 MB of the built JS) and pulling them in eagerly is the price
 * of not being able to dynamically import inside a synchronous registry. If
 * that cost ever matters, the fix is a dynamic `import()` at registration
 * time, not a second registry.
 */

import { registerCharacterBackend } from '../CharacterHost';
import { MmdBackend } from './MmdBackend';

registerCharacterBackend('mmd', () => new MmdBackend());

export { MmdBackend };
