# 阿里云轻量服务器部署

适用环境：Ubuntu 22.04、2核4G及以上。

首次部署（root执行）：

```bash
curl -fsSL https://raw.githubusercontent.com/798114992/gongkaorilian/main/deploy/install-aliyun.sh | bash
```

备案完成前，可使用私有模式部署。该模式仅在服务器本机监听 HTTP：

```bash
curl -fsSL https://raw.githubusercontent.com/798114992/gongkaorilian/main/deploy/install-aliyun.sh | sudo env PRIVATE_MODE=true bash
```

以后更新：

```bash
sudo gongkaorilian-update
```

查看服务状态：

```bash
sudo systemctl status gongkaorilian --no-pager
sudo journalctl -u gongkaorilian -n 100 --no-pager
```

初始管理员密码只在服务器的 root 私有文件中保存：

```bash
sudo cat /root/gongkaorilian-initial-admin-password.txt
```

数据库和媒体文件位于 `/opt/gongkaorilian/data`；数据库每天03:20自动备份，保留14天。

绑定域名并完成备案后，再配置HTTPS。微信小程序正式环境不得使用裸IP或HTTP地址。
