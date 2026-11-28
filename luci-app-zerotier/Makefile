# SPDX-License-Identifier: Apache-2.0
#
# LuCI app for ZeroTier (control panel).

include $(TOPDIR)/rules.mk

LUCI_NAME:=luci-app-zerotier

LUCI_TITLE:=LuCI app for ZeroTier
LUCI_DEPENDS:=+zerotier
LUCI_PKGARCH:=all
LUCI_DESCRIPTION:=ZeroTier control panel: node state, networks, peers, join/leave

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=moseszz007 <https://github.com/moseszz007>

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
