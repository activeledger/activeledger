# Activerestore

Activerestore是独立于Activeledger的应用， 用来更正未在共识机制下写入的数据并且可在必要情况下重建整个链。

在使用CouchDB作为数据库的情况下Activeledger需要对CouchDB所在文件夹拥有访问权限。

## Full Rebuild

以 --full 来运行restore进行整个链的重建， 这个过程可能花费很久的时间但是程序会在重建完成会自动停止运行。在重建完成后你可以正常运行这个程序（不加 --full）， 它会自动监听并检查错误。
