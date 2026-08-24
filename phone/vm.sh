#!/data/data/com.termux/files/usr/bin/bash
cd ~/alpine
qemu-system-aarch64 -M virt -cpu cortex-a72 -smp 4 -m 4096 -bios $PREFIX/share/qemu/edk2-aarch64-code.fd -drive file=alpine.qcow2,if=virtio,format=qcow2 -netdev user,id=n0,hostfwd=tcp::2222-:22,hostfwd=tcp::3001-:3000 -device virtio-net-pci,netdev=n0 -nographic
