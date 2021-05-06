#!/usr/bin/env bash
k="kubectl"
$k -n team-admin port-forward svc/drone 8081:80 &
$k -n gitea port-forward svc/gitea-http 8082:3000 &
$k -n harbor port-forward svc/harbor-harbor-core 8083:80 &
$k -n keycloak port-forward svc/keycloak-http 8084:80 &
