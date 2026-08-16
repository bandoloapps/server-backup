import { STRING, Sequelize } from "sequelize";

export const define_channels = (sequelize: Sequelize) => {
    const model = sequelize.define('channels', {
            channelId: {
                type: STRING,
                primaryKey: true
            },
            name: {
                type: STRING
            },
            type: {
                type: STRING
            },
            parentId: {
                type: STRING,
                allowNull: true
            }
        }, {timestamps: false, freezeTableName: true})

    return model;
}
