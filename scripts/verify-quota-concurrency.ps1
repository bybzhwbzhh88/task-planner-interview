param(
  [Parameter(Mandatory = $true)]
  [string]$UserId,
  [ValidateRange(1, 100)]
  [int]$InitialCredits = 3,
  [ValidateRange(1, 100)]
  [int]$AttemptCount = 5
)

if (-not $env:DATABASE_URL) {
  throw "Set DATABASE_URL to the local PostgreSQL connection string before running this script."
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
  throw "psql was not found. Install the PostgreSQL client or run this script where it is available."
}

$escapedUserId = $UserId.Replace("'", "''")
$resetSql = "UPDATE `"User`" SET credits = $InitialCredits WHERE id = '$escapedUserId';"
& psql --dbname=$env:DATABASE_URL --quiet --command $resetSql
if ($LASTEXITCODE -ne 0) { throw "Could not reset the user's credits." }

$reserveSql = "WITH reserved AS (UPDATE `"User`" SET credits = credits - 1 WHERE id = '$escapedUserId' AND credits > 0 RETURNING 1) SELECT count(*) FROM reserved;"
$jobs = 1..$AttemptCount | ForEach-Object {
  Start-Job -ScriptBlock {
    param($databaseUrl, $sql)
    $output = & psql --dbname=$databaseUrl --tuples-only --no-align --quiet --command $sql
    [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = $output.Trim() }
  } -ArgumentList $env:DATABASE_URL, $reserveSql
}
$results = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job

if (($results | Where-Object ExitCode -ne 0).Count -gt 0) {
  throw "At least one concurrent reservation query failed."
}
$successfulReservations = @($results | Where-Object Output -eq "1").Count
$finalCredits = (& psql --dbname=$env:DATABASE_URL --tuples-only --no-align --quiet --command "SELECT credits FROM `"User`" WHERE id = '$escapedUserId';").Trim()
$expectedReservations = [Math]::Min($InitialCredits, $AttemptCount)

Write-Host "successful reservations: $successfulReservations"
Write-Host "final credits: $finalCredits"
if ($successfulReservations -ne $expectedReservations -or $finalCredits -ne ($InitialCredits - $expectedReservations).ToString()) {
  throw "Expected $expectedReservations reservations and $($InitialCredits - $expectedReservations) final credits."
}

Write-Host "PASS: conditional update prevents concurrent overdraft."
