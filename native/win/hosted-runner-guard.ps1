function Assert-GitHubHostedRunner {
  param(
    [string]$GithubActions = $env:GITHUB_ACTIONS,
    [string]$RunnerEnvironment = $env:RUNNER_ENVIRONMENT
  )

  $isGithubActions = [string]::Equals(
    $GithubActions,
    'true',
    [System.StringComparison]::OrdinalIgnoreCase
  )
  $isGithubHosted = [string]::Equals(
    $RunnerEnvironment,
    'github-hosted',
    [System.StringComparison]::OrdinalIgnoreCase
  )

  if (-not $isGithubActions -or -not $isGithubHosted) {
    throw 'Windows lifecycle verification is destructive and may run only on a GitHub-hosted runner.'
  }
}
