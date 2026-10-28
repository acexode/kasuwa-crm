module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'repo', 'ci', 'api', 'web', 'worker', 'realtime',
        'db', 'config', 'ui', 'i18n', 'testing', 'permissions',
        'metadata', 'telephony', 'wfm', 'payments', 'commerce', 'core', 'flags',
        'docs', 'team', 'claude', 'acceptance', 'security',
      ],
    ],
  },
};
