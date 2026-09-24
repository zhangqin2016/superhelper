# Sourced by the deploy scripts. What ships is a commit, never the working tree.
#
# Images are tagged by commit sha. Packaging or building from the working tree
# once carried another stream's uncommitted work — including a database
# migration — toward production under a tag that did not contain it. Exporting
# the commit makes the tag true by construction: untracked and modified files
# cannot ship, and they are named rather than dropped silently.
#
#   export_commit_source <root> <dest-dir>
#     DEPLOY_REF (default HEAD) is exported into <dest-dir>; sets DEPLOY_SHA.

export_commit_source() {
  _root="$1"
  _dest="$2"
  DEPLOY_REF="${DEPLOY_REF:-HEAD}"
  DEPLOY_SHA="$(git -C "$_root" rev-parse --short=8 "$DEPLOY_REF")"
  _dirty="$(git -C "$_root" status --porcelain --untracked-files=all -- .dockerignore server web deploy/baota)"
  if [ -n "$_dirty" ]; then
    echo "Deploying commit $DEPLOY_SHA; these uncommitted paths are NOT included:"
    echo "$_dirty" | sed 's/^/  /'
  fi
  mkdir -p "$_dest"
  git -C "$_root" archive "$DEPLOY_REF" .dockerignore server web deploy/baota | tar -x -C "$_dest"
  echo "Exported commit $DEPLOY_SHA"
}
