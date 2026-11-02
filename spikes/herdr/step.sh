# Usage: source step.sh; step <name> <herdr args...>  — runs herdr in the isolated session and saves the output.
H_SESSION=${H_SESSION:-lunasq-spike}
step() {
  n=$1; shift
  echo "\$ herdr --session $H_SESSION $*" > outputs/$n.txt
  herdr --session "$H_SESSION" "$@" > outputs/$n.json 2> outputs/$n.stderr
  echo "exit=$?" >> outputs/$n.txt
  echo "== $n ($(tail -1 outputs/$n.txt))"; cat outputs/$n.json outputs/$n.stderr | head -c 1800; echo
  [ -s outputs/$n.stderr ] || rm outputs/$n.stderr
}
