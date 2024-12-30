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

sed -i 's/24.12.18/24.12.28/g' feeds/packages/net/xray-core/Makefile
sed -i 's/3d8b4a161a263e7af7bb1a2690961da075d13f980acd806f5cd4e5c8338d7534/9e7e14ac1da5aac22382b485bb2af3bbef07dc5e3b583e464c479f8f0f06b2d5/g' feeds/packages/net/xray-core/Makefile

sed -i 's/1.9.7/1.10.5/g' feeds/packages/net/sing-box/Makefile
sed -i 's/5b015352f3434bb780af01a6b1f6c0fe706166d6c44a69547e29892f0920b944/ca0385b45d160c2c2a1d0e09665f4f04caac27cb3dd9d6132173316dfd873b75/g' feeds/packages/net/sing-box/Makefile

git pull && git add -A && git commit -am "Initial commit" && git push

