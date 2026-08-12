import type { ChangedFile, Policy, Trigger } from './types.js';

const PATTERNS: Array<{ trigger: Trigger; test: RegExp }> = [
  { trigger: 'backend_changed', test: /(^|\/)(src|app|lib)\/.*\.(ts|js|java|py|go|rb|cs)$/i },
  { trigger: 'backend_changed', test: /(service|repository|usecase|handler)s?\//i },
  { trigger: 'database_changed', test: /(^|\/)(migrations?|db|database)\//i },
  { trigger: 'database_changed', test: /\.sql$/i },
  { trigger: 'database_changed', test: /(entity|entities|model|schema)s?\//i },
  { trigger: 'infra_changed', test: /(^|\/)Dockerfile/i },
  { trigger: 'infra_changed', test: /docker-compose\.ya?ml$/i },
  { trigger: 'infra_changed', test: /^\.github\/workflows\// },
  { trigger: 'infra_changed', test: /\.(tf|tfvars)$/i },
  { trigger: 'infra_changed', test: /(^|\/)k8s\//i },
  { trigger: 'auth_changed', test: /(auth|login|session|permission|role|token|jwt)/i },
  { trigger: 'deps_changed', test: /(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|pom\.xml|build\.gradle|requirements\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock))$/ },
  { trigger: 'endpoints_changed', test: /(controller|route|endpoint|resource)s?/i },
  { trigger: 'endpoints_changed', test: /openapi|swagger/i },
];

export function resolveTriggers(files: ChangedFile[]): Set<Trigger> {
  const triggers = new Set<Trigger>();
  for (const f of files) {
    for (const { trigger, test } of PATTERNS) {
      if (test.test(f.path)) triggers.add(trigger);
    }
  }
  return triggers;
}

export interface SelectOptions {
  criteriaAvailable: boolean;
  testsFailed: boolean;
}

export function selectAuditors(
  policy: Policy,
  files: ChangedFile[],
  opts: SelectOptions,
): string[] {
  const triggers = resolveTriggers(files);

  const applicable = Object.entries(policy.auditors)
    .filter(([, cfg]) => {
      if (cfg.when === 'always') return true;
      if (cfg.when === 'criteria_available') return opts.criteriaAvailable;
      return cfg.when.some((t) => triggers.has(t));
    })
    .map(([name]) => name);

  if (!opts.testsFailed) return applicable;

  const allowed = new Set(policy.onTestFailure.runAuditors);
  return applicable.filter((name) => allowed.has(name));
}
