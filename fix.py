import zipfile,os
z=zipfile.ZipFile("./bad.zip")
for n in z.namelist():
    t="./out/"+n.replace("\\","/")
    if t.endswith("/"):
        os.makedirs(t,exist_ok=True);continue
    os.makedirs(os.path.dirname(t),exist_ok=True)
    open(t,"wb").write(z.read(n))
print("解压完成: 共",len(z.namelist()),"个文件")
