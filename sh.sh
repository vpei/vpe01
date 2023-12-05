# git pull && sh sh.sh

#删除docker无脑初始化教程
# sed -i '31,39d' package/lean/luci-app-docker/po/zh-cn/docker.po
# rm -rf lean/luci-app-docker/root/www

# cd ./luci-app-openclash
# svn update
# cd ../

#svn co https://github.com/kenzok8/openwrt-packages/trunk/luci-app-passwall luci-app-passwall
#cd ./luci-app-passwall
#svn update
#cd ../

# cd ./luci-app-openclash
# svn update
# cd ../

git pull && git add -A && git commit -am "Initial commit" && git push
