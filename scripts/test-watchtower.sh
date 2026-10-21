#!/bin/sh
# Exercise the exact configured Watchtower image against the runner's real Docker daemon.
# The fixtures override the application command and never log into Engage.
set -eu

fixture_base_image=${1:?Pass the tested application image}
fixture_watchtower_image=${2:?Pass the configured Watchtower image}
fixture_prefix="dsas-watchtower-${GITHUB_RUN_ID:-$$}"
fixture_image="${fixture_prefix}:latest"
fixture_app="${fixture_prefix}-app"
fixture_ignored="${fixture_prefix}-ignored"
fixture_other="${fixture_prefix}-other"

cleanup() {
  docker rm -f "$fixture_app" "$fixture_ignored" "$fixture_other" >/dev/null 2>&1 || true
  docker image rm "$fixture_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

docker tag "$fixture_base_image" "$fixture_image"
for fixture_kind in app ignored other; do
  fixture_scope=$fixture_prefix
  fixture_enabled=true
  if [ "$fixture_kind" = ignored ]; then fixture_enabled=false; fi
  if [ "$fixture_kind" = other ]; then fixture_scope="${fixture_prefix}-other"; fi
  docker run --detach --name "${fixture_prefix}-${fixture_kind}" --init --no-healthcheck \
    --env DSAS_WATCHTOWER_FIXTURE=retained \
    --label "com.centurylinklabs.watchtower.enable=$fixture_enabled" \
    --label "com.centurylinklabs.watchtower.scope=$fixture_scope" \
    "$fixture_image" bun --eval 'setInterval(() => {}, 1000)' >/dev/null
done
fixture_old_app=$(docker inspect --format '{{.Id}}' "$fixture_app")
fixture_old_ignored=$(docker inspect --format '{{.Id}}' "$fixture_ignored")
fixture_old_other=$(docker inspect --format '{{.Id}}' "$fixture_other")

# A new local image ID is sufficient for --no-pull update detection.
docker build --tag "$fixture_image" - <<BUILD
FROM $fixture_base_image
LABEL dev.dsas.watchtower-fixture="updated"
BUILD
fixture_new_image=$(docker image inspect --format '{{.Id}}' "$fixture_image")
docker run --rm \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --label com.centurylinklabs.watchtower.enable=false \
  --label "com.centurylinklabs.watchtower.scope=$fixture_prefix" \
  --env "DOCKER_API_VERSION=${WATCHTOWER_DOCKER_API_VERSION:-1.44}" \
  "$fixture_watchtower_image" --run-once --no-pull --label-enable \
  --scope "$fixture_prefix" --stop-timeout 25s

[ "$(docker inspect --format '{{.Id}}' "$fixture_app")" != "$fixture_old_app" ]
[ "$(docker inspect --format '{{.Image}}' "$fixture_app")" = "$fixture_new_image" ]
[ "$(docker inspect --format '{{.State.Running}}' "$fixture_app")" = true ]
[ "$(docker inspect --format '{{.HostConfig.Init}}' "$fixture_app")" = true ]
[ "$(docker inspect --format '{{.Id}}' "$fixture_ignored")" = "$fixture_old_ignored" ]
[ "$(docker inspect --format '{{.Id}}' "$fixture_other")" = "$fixture_old_other" ]
case "$(docker inspect --format '{{json .Config.Env}}' "$fixture_app")" in
  *'"DSAS_WATCHTOWER_FIXTURE=retained"'*) ;;
  *) exit 1 ;;
esac
printf '%s\n' 'Watchtower updated the selected app, retained its settings, and excluded other containers.'
