#!/bin/sh
# tauri 打的 rpm 只登记资源的顶层目录（/usr/lib/DataOmni），不登记下面的 instantclient，
# 卸载后两层空目录留着（Fedora 42 上验过；deb 没有这个问题）。
# $1 = 0 是整个卸载；升级时（$1 >= 1）新包的文件已经在里面，不能动。
if [ "$1" = 0 ]; then
  rmdir /usr/lib/DataOmni/instantclient /usr/lib/DataOmni 2>/dev/null || true
fi
