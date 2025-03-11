# git pull && sh sh.sh

export GO111MODULE=on
export GOPROXY=https://goproxy.cn
export GOPROXY=https://goproxy.io

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

sed -i 's/24.12.31/25.1.30/g' feeds/packages/net/xray-core/Makefile
sed -i 's/e3c24b561ab422785ee8b7d4a15e44db159d9aa249eb29a36ad1519c15267be0/983ee395f085ed1b7fbe0152cb56a5b605a6f70a5645d427c7186c476f14894e/g' feeds/packages/net/xray-core/Makefile

sed -i 's/1.10.7/1.11.0/g' feeds/packages/net/sing-box/Makefile
sed -i 's/402b618148b58f5ff6c1bee4f4fdcf7cdcb88a2df6a8bd682ea742a89b5be9ec/d4a48b2fe450041fea2d25955ddc092a62afc8da7bb442b49cb12575123b2edb/g' feeds/packages/net/sing-box/Makefile

git pull && git add -A && git commit -am "Initial commit" && git push

