// The worker entry the planner bundle needs (see core/js/web.ts): serve the heavy kernels on this worker's scope.
import { serveKernels } from '../../../../js/web.ts'

serveKernels(self, new URL('/wasm/midstudy_wasm_web_bg.wasm', self.location.href))
