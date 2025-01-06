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

sed -i 's/24.12.28/25.1.1/g' feeds/packages/net/xray-core/Makefile
sed -i 's/9e7e14ac1da5aac22382b485bb2af3bbef07dc5e3b583e464c479f8f0f06b2d5/619b10d24bab367a0788b3585f8d31fa4e5e060be7f72647d6ee17bd744603a5/g' feeds/packages/net/xray-core/Makefile

sed -i 's/1.10.5/1.10.6/g' feeds/packages/net/sing-box/Makefile
sed -i 's/ca0385b45d160c2c2a1d0e09665f4f04caac27cb3dd9d6132173316dfd873b75/bb3ca59c848f1509d0e183c54c91716993ce77ab0c9c48a0de0bcd4cc1f0e021/g' feeds/packages/net/sing-box/Makefile

git pull && git add -A && git commit -am "Initial commit" && git push

