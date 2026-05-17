import type { Rule } from '../types.js';
import { noChildProcess } from './no-child-process.js';
import { noFsOutsideTmp } from './no-fs-outside-tmp.js';
import { noEval } from './no-eval.js';
import { noNonAllowlistedNetwork } from './no-non-allowlisted-network.js';
import { depAllowlist,  } from './dep-allowlist.js';
import { noProcessEnvWrite } from './no-process-env-write.js';
import { noUnboundedLoops } from './no-unbounded-loops.js';



/**
 * All AST rules, in the order they run. `depAllowlist` is included for
 * completeness but its AST `check` is a no-op (it's wired through
 * scanner.scanPackageJson instead).
 */
export const ALL_RULES: Rule[] = [
  noChildProcess,
  noFsOutsideTmp,
  noEval,
  noNonAllowlistedNetwork,
  noProcessEnvWrite,
  noUnboundedLoops,
  depAllowlist,
];

export {checkPackageJson, depAllowlist} from './dep-allowlist.js';
export {noChildProcess} from './no-child-process.js';
export {noFsOutsideTmp} from './no-fs-outside-tmp.js';
export {noEval} from './no-eval.js';
export {noNonAllowlistedNetwork} from './no-non-allowlisted-network.js';
export {noProcessEnvWrite} from './no-process-env-write.js';
export {noUnboundedLoops} from './no-unbounded-loops.js';