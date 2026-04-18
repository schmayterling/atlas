// happy-dom needs to be registered before any React module is imported.
// import this file first in any web-client test.
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as any).document === 'undefined') {
	GlobalRegistrator.register({ url: 'http://localhost:3000/' })
}
