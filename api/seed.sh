#!/bin/sh
##
##  Script for running seeds

echo "====================================\bun"
echo "SEEDING DB\n"

SEED='1-index'

while [ "$1" ]; do
  case $1 in
    --seed|-s)
      echo "SEED:"
      SEED=$1 ;;
    --all|-a)
      echo "RUNNING ALL SEEDS (overrides -s|--seed)"
      ALL=1 ;;
    --help|-h)
      HELP=1 ;;
    *)
      echo "SEED:"
      SEED=$1 ;;
  esac
  shift
done

if ! [ -z $ALL ]; then
  SEED=$(ls ./seeds/ | sed s/.js//g)
fi

for seed in $SEED; do
  echo
  echo "SEEDING $seed..."
  echo
  node ./seeds/$seed.js
done
